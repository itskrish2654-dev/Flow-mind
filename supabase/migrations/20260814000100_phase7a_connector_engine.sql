begin;

create table if not exists public.connector_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id text not null,
  provider_family text not null,
  external_account_id text not null,
  external_account_label text,
  auth_type text not null check (auth_type in ('none', 'api_key', 'oauth2')),
  status text not null default 'connected' check (status in ('connected', 'expired', 'revoked', 'error')),
  granted_scopes text[] not null default '{}',
  token_expires_at timestamptz,
  last_refreshed_at timestamptz,
  last_error_category text,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, connector_id, external_account_id),
  check (char_length(connector_id) between 3 and 80),
  check (char_length(provider_family) between 1 and 80),
  check (char_length(external_account_id) between 1 and 255)
);

create table if not exists public.connector_connection_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connector_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  credential_key text not null,
  credential_type text not null,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  encryption_version smallint not null default 1 check (encryption_version = 1),
  algorithm text not null default 'aes-256-gcm' check (algorithm = 'aes-256-gcm'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (connection_id, credential_key)
);

create table if not exists public.connector_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id text not null,
  provider_family text not null,
  requested_scopes text[] not null default '{}',
  return_path text not null,
  pkce_ciphertext text not null,
  pkce_nonce text not null,
  pkce_auth_tag text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (return_path ~ '^/[A-Za-z0-9/_?=&.%-]*$')
);

create table if not exists public.connector_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  workflow_version_id uuid not null references public.workflow_versions(id) on delete cascade,
  connection_id uuid references public.connector_connections(id) on delete cascade,
  connector_id text not null,
  operation_key text not null,
  operation_version integer not null check (operation_version > 0),
  provider_subscription_id text,
  endpoint_token_hash text,
  status text not null default 'active' check (status in ('active', 'paused', 'expired', 'revoked', 'error')),
  cursor_value text,
  renew_after timestamptz,
  expires_at timestamptz,
  last_event_at timestamptz,
  last_error_category text,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workflow_version_id, connector_id, operation_key)
);

create table if not exists public.connector_event_receipts (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.connector_subscriptions(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  workflow_version_id uuid not null references public.workflow_versions(id) on delete cascade,
  provider_event_key text not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'succeeded', 'failed', 'duplicate')),
  payload jsonb not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  execution_id uuid references public.workflow_executions(id) on delete set null,
  received_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  expires_at timestamptz not null default (clock_timestamp() + interval '30 days'),
  unique (subscription_id, provider_event_key)
);

create index if not exists connector_connections_owner_idx on public.connector_connections(user_id, status);
create index if not exists connector_subscriptions_workflow_idx on public.connector_subscriptions(workflow_id, status);
create index if not exists connector_subscriptions_renewal_idx on public.connector_subscriptions(status, renew_after) where status = 'active';
create index if not exists connector_event_receipts_queue_idx on public.connector_event_receipts(status, received_at) where status = 'queued';
create index if not exists connector_event_receipts_expiry_idx on public.connector_event_receipts(expires_at);

alter table public.connector_connections enable row level security;
alter table public.connector_connections force row level security;
alter table public.connector_connection_credentials enable row level security;
alter table public.connector_connection_credentials force row level security;
alter table public.connector_oauth_states enable row level security;
alter table public.connector_oauth_states force row level security;
alter table public.connector_subscriptions enable row level security;
alter table public.connector_subscriptions force row level security;
alter table public.connector_event_receipts enable row level security;
alter table public.connector_event_receipts force row level security;

revoke all on public.connector_connections, public.connector_connection_credentials, public.connector_oauth_states, public.connector_subscriptions, public.connector_event_receipts from public, anon, authenticated;
grant select on public.connector_connections to authenticated;
grant all on public.connector_connections, public.connector_connection_credentials, public.connector_oauth_states, public.connector_subscriptions, public.connector_event_receipts to service_role;

drop policy if exists connector_connections_owner_select on public.connector_connections;
create policy connector_connections_owner_select on public.connector_connections for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.claim_connector_token_refresh(p_connection_id uuid, p_user_id uuid, p_lease_seconds integer default 30)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare claimed integer;
begin
  if p_connection_id is null or p_user_id is null or p_lease_seconds < 5 or p_lease_seconds > 120 then
    raise exception 'invalid refresh claim';
  end if;
  update public.connector_connections
  set safe_metadata = safe_metadata || jsonb_build_object('refresh_lease_until', clock_timestamp() + make_interval(secs => p_lease_seconds)),
      updated_at = clock_timestamp()
  where id = p_connection_id and user_id = p_user_id
    and status in ('connected', 'expired')
    and coalesce((safe_metadata->>'refresh_lease_until')::timestamptz, '-infinity'::timestamptz) < clock_timestamp();
  get diagnostics claimed = row_count;
  return claimed = 1;
end;
$$;

create or replace function public.release_connector_token_refresh(p_connection_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare released integer;
begin
  update public.connector_connections
  set safe_metadata = safe_metadata - 'refresh_lease_until', updated_at = clock_timestamp()
  where id = p_connection_id and user_id = p_user_id;
  get diagnostics released = row_count;
  return released = 1;
end;
$$;

revoke all on function public.claim_connector_token_refresh(uuid, uuid, integer), public.release_connector_token_refresh(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_connector_token_refresh(uuid, uuid, integer), public.release_connector_token_refresh(uuid, uuid) to service_role;

-- Extend account erasure without weakening the existing owner/job checks.
create or replace function public.cleanup_connector_account_data(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  if p_user_id is null then raise exception 'invalid account cleanup request'; end if;
  delete from public.connector_event_receipts where subscription_id in (select id from public.connector_subscriptions where user_id = p_user_id);
  delete from public.connector_subscriptions where user_id = p_user_id;
  delete from public.connector_connection_credentials where user_id = p_user_id;
  delete from public.connector_oauth_states where user_id = p_user_id;
  delete from public.connector_connections where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.cleanup_connector_account_data(uuid) from public, anon, authenticated;
grant execute on function public.cleanup_connector_account_data(uuid) to service_role;

commit;
