-- =====================================================================
-- Presso Center : newsletter
--
-- Les abonnés s'inscrivent eux-mêmes (formulaire du site, case à cocher à la
-- réservation) ou sont ajoutés par le gérant avec leur accord. Chaque newsletter
-- contient un lien de désinscription personnel (jeton).
--
-- L'envoi passe par la fonction Edge « mail » (route /newsletter), réservée
-- au compte gérant. La table n'est lisible que par lui (RLS) ; le public n'y
-- accède que par les deux fonctions ci-dessous.
-- =====================================================================

create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  name text,
  source text not null default 'site' check (source in ('site', 'reservation', 'manuel')),
  token uuid not null default gen_random_uuid(),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists subscribers_email_idx on public.subscribers (lower(email));
create unique index if not exists subscribers_token_idx on public.subscribers (token);

alter table public.subscribers enable row level security;
drop policy if exists admin_all on public.subscribers;
create policy admin_all on public.subscribers for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- Inscription depuis le site : { email, name, source }
create or replace function public.newsletter_subscribe(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p ->> 'email', '')));
  v_name text := nullif(btrim(coalesce(p ->> 'name', '')), '');
  v_source text := case when p ->> 'source' = 'reservation' then 'reservation' else 'site' end;
begin
  if length(v_email) > 160 or v_email !~ '^[^[:space:]@<>",;]+@[^[:space:]@<>",;]+\.[^[:space:]@<>",;]{2,}$' then
    raise exception 'Adresse e-mail invalide.';
  end if;
  if length(coalesce(v_name, '')) > 120 then
    raise exception 'Informations trop longues.';
  end if;
  -- garde-fou contre un remplissage automatique du formulaire
  if (select count(*) from public.subscribers where created_at > now() - interval '1 day') >= 200 then
    raise exception 'Trop d''inscriptions aujourd''hui : réessaie demain.';
  end if;
  insert into public.subscribers (email, name, source)
  values (v_email, v_name, v_source)
  on conflict (lower(email)) do update
    set unsubscribed_at = null,
        name = coalesce(excluded.name, public.subscribers.name);
  return jsonb_build_object('ok', true);
end;
$$;

-- Désinscription avec le jeton reçu dans chaque newsletter
create or replace function public.newsletter_unsubscribe(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  update public.subscribers
     set unsubscribed_at = coalesce(unsubscribed_at, now())
   where token = p_token
  returning email into v_email;
  if v_email is null then
    return jsonb_build_object('ok', false);
  end if;
  -- adresse en partie masquée : la page de désinscription la rappelle à la personne
  return jsonb_build_object('ok', true, 'email', regexp_replace(v_email, '^(.{1,2})[^@]*', '\1***'));
end;
$$;

revoke execute on function public.newsletter_subscribe(jsonb) from public;
revoke execute on function public.newsletter_unsubscribe(uuid) from public;
grant execute on function public.newsletter_subscribe(jsonb) to anon, authenticated;
grant execute on function public.newsletter_unsubscribe(uuid) to anon, authenticated;
