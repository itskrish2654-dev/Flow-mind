begin;

-- Stores only the short-lived, encrypted initial Notion verification token.
-- Browser roles have no privileges; retrieval is a one-time service operation.
create table if not exists public.connector_provider_setup_secrets (
  provider text primary key,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  encryption_version smallint not null default 1 check (encryption_version = 1),
  algorithm text not null default 'aes-256-gcm' check (algorithm = 'aes-256-gcm'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.connector_provider_setup_secrets enable row level security;
alter table public.connector_provider_setup_secrets force row level security;
revoke all on public.connector_provider_setup_secrets from public, anon, authenticated;
grant all on public.connector_provider_setup_secrets to service_role;

commit;
