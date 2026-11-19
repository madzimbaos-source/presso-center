-- =====================================================================
-- Presso Center : déclencheurs d'e-mails (Resend)
--
-- À chaque événement, la base appelle la fonction Edge « mail », qui envoie
-- les e-mails avec Resend (voir supabase/functions/mail/index.ts) :
--   - nouvelle réservation en ligne  -> alerte au gérant + accusé de réception au client
--   - demande passée à « confirmée » -> confirmation au client
--   - demande de test pilote         -> alerte au gérant
--
-- L'appel est asynchrone (pg_net) et protégé : une erreur d'e-mail ne bloque
-- jamais une réservation. L'adresse de la fonction et le secret partagé sont
-- dans Supabase Vault, pas dans ce fichier :
--   select vault.create_secret('<url de la fonction>/notify', 'presso_mail_url');
--   select vault.create_secret('<secret partagé>', 'presso_hook_secret');
-- =====================================================================

create extension if not exists pg_net;

create or replace function public.send_mail_event(p_kind text, p_record jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'presso_mail_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'presso_hook_secret';
  if v_url is null or v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('kind', p_kind, 'record', p_record),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', v_secret),
    timeout_milliseconds := 15000
  );
exception when others then
  raise warning 'send_mail_event : %', sqlerrm;
end;
$$;

create or replace function public.bookings_mail_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  s jsonb;
  v_kind text;
begin
  if new.kind not in ('seance', 'domicile') then
    return new;
  end if;
  if tg_op = 'INSERT' and new.source = 'en_ligne' then
    v_kind := 'booking_new';
  elsif tg_op = 'UPDATE' and old.status = 'demande' and new.status = 'confirmee' then
    v_kind := 'booking_confirmed';
  else
    return new;
  end if;

  select data into s from public.settings where id = 'main';
  perform public.send_mail_event(
    v_kind,
    to_jsonb(new) || jsonb_build_object(
      'service_name', (select x ->> 'name'
                         from jsonb_array_elements(coalesce(s -> 'services', '[]'::jsonb)) as x
                        where x ->> 'code' = new.service
                        limit 1),
      'base_location', s ->> 'base_location'
    )
  );
  return new;
exception when others then
  raise warning 'bookings_mail_trigger : %', sqlerrm;
  return new;
end;
$$;

create or replace function public.partners_mail_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'demande' then
    perform public.send_mail_event('club_request', to_jsonb(new));
  end if;
  return new;
exception when others then
  raise warning 'partners_mail_trigger : %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists bookings_mail_insert on public.bookings;
create trigger bookings_mail_insert
  after insert on public.bookings
  for each row execute function public.bookings_mail_trigger();

drop trigger if exists bookings_mail_status on public.bookings;
create trigger bookings_mail_status
  after update of status on public.bookings
  for each row execute function public.bookings_mail_trigger();

drop trigger if exists partners_mail_insert on public.partners;
create trigger partners_mail_insert
  after insert on public.partners
  for each row execute function public.partners_mail_trigger();

-- Ces fonctions ne sont appelées que par les déclencheurs
revoke execute on function public.send_mail_event(text, jsonb) from public, anon, authenticated;
revoke execute on function public.bookings_mail_trigger() from public, anon, authenticated;
revoke execute on function public.partners_mail_trigger() from public, anon, authenticated;
