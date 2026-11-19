-- =====================================================================
-- Presso Center : messagerie de l'espace de gestion
-- Les e-mails reçus sur @pressocenter.fr sont enregistrés ici par la
-- fonction Edge « mail » (qui en envoie aussi une copie au gérant), ainsi
-- que les réponses envoyées depuis l'application.
-- Lecture et écriture réservées au compte gérant (RLS).
-- =====================================================================

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('in', 'out')),
  from_name text,
  from_email text,
  to_email text,
  subject text,
  body text,
  attachments jsonb not null default '[]'::jsonb,
  resend_id text unique,
  message_id text,
  reply_to_id uuid references public.messages (id) on delete set null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_created_idx on public.messages (created_at desc);
create index if not exists messages_reply_idx on public.messages (reply_to_id);

alter table public.messages enable row level security;
drop policy if exists admin_all on public.messages;
create policy admin_all on public.messages for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
