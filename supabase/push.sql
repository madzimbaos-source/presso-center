-- =====================================================================
-- Presso Center : notifications sur le téléphone (Web Push)
--
-- Chaque appareil du gérant qui active les notifications enregistre ici son
-- abonnement. La fonction Edge « mail » s'en sert pour prévenir d'une nouvelle
-- demande de réservation, d'une demande de test pilote ou d'un message reçu.
-- Table réservée au compte gérant (RLS) ; la clé privée d'envoi (VAPID) est
-- un secret de la fonction, jamais stockée ici.
-- =====================================================================

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  device text check (length(device) <= 200),
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
drop policy if exists admin_all on public.push_subscriptions;
create policy admin_all on public.push_subscriptions for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
