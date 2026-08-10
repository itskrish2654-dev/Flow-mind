begin;

-- Publication is explicit. Legacy links were created under an implicit-public
-- default, so they are revoked and owners must deliberately publish them again.
alter table public.workflows
  alter column public_form_enabled set default false;

-- Workflow mutations pass through server actions so publication and quotas
-- cannot be bypassed with the public authenticated browser key.
revoke insert, update, delete on table public.workflows from authenticated;
grant select on table public.workflows to authenticated;

alter table public.workflows
  add column if not exists published_at timestamptz,
  add column if not exists public_form_challenge_mode text not null default 'honeypot';

update public.workflows
set public_form_enabled = false,
    published_at = null
where public_form_enabled;

alter table public.workflows
  drop constraint if exists workflows_public_form_challenge_mode_check;
alter table public.workflows
  add constraint workflows_public_form_challenge_mode_check
  check (public_form_challenge_mode in ('honeypot', 'turnstile'));

-- The anonymous renderer receives only presentation fields and the challenge
-- mode. Executable steps and owner identifiers remain server-only.
drop function if exists public.get_public_workflow(uuid);
create function public.get_public_workflow(p_workflow_id uuid)
returns table (
  id uuid,
  name text,
  workflow_name text,
  summary text,
  public_form jsonb,
  challenge_mode text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    workflow.id,
    workflow.name,
    coalesce(workflow.compiled_steps ->> 'workflowName', workflow.name),
    coalesce(
      workflow.compiled_steps ->> 'summary',
      'Submit information to this FlowMind automation.'
    ),
    workflow.compiled_steps -> 'publicForm',
    workflow.public_form_challenge_mode
  from public.workflows as workflow
  where workflow.id = p_workflow_id
    and workflow.public_form_enabled
    and workflow.compiled_steps is not null
  limit 1;
$$;
revoke all on function public.get_public_workflow(uuid) from public;
grant execute on function public.get_public_workflow(uuid) to anon, authenticated;

-- Execution rows are trusted server records. Neither anon nor authenticated
-- browser clients may create or mutate them; the service role writes them.
drop policy if exists "Public forms can create execution logs" on public.workflow_executions;
drop policy if exists "Users can create their own execution logs" on public.workflow_executions;
revoke all on table public.workflow_executions from anon, authenticated;
grant select on table public.workflow_executions to authenticated;

drop policy if exists "Users can update their own execution logs" on public.workflow_executions;
drop policy if exists "Users can delete their own execution logs" on public.workflow_executions;

-- Credential ciphertext is never exposed through the browser Supabase role.
create table if not exists public.workflow_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  connector_id text not null,
  credential_key text not null,
  credential_type text not null,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  encryption_version integer not null default 1,
  algorithm text not null default 'aes-256-gcm',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, workflow_id, connector_id, credential_key),
  constraint workflow_credentials_connector_length check (char_length(connector_id) between 1 and 80),
  constraint workflow_credentials_key_length check (char_length(credential_key) between 1 and 80),
  constraint workflow_credentials_type_length check (char_length(credential_type) between 1 and 40),
  constraint workflow_credentials_algorithm check (algorithm = 'aes-256-gcm'),
  constraint workflow_credentials_version check (encryption_version = 1)
);

create index if not exists workflow_credentials_owner_workflow_idx
  on public.workflow_credentials(user_id, workflow_id);

alter table public.workflow_credentials enable row level security;
alter table public.workflow_credentials force row level security;
revoke all on table public.workflow_credentials from public, anon, authenticated;
grant all on table public.workflow_credentials to service_role;

-- Private document metadata is server-owned. Storage paths are not client authority.
create table if not exists public.generated_document_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  content_type text not null default 'application/pdf',
  size_bytes bigint not null,
  created_at timestamptz not null default now(),
  constraint generated_documents_size check (size_bytes between 1 and 5242880),
  constraint generated_documents_content_type check (content_type = 'application/pdf')
);

create index if not exists generated_document_records_owner_workflow_idx
  on public.generated_document_records(user_id, workflow_id, created_at desc);

alter table public.generated_document_records enable row level security;
alter table public.generated_document_records force row level security;
revoke all on table public.generated_document_records from public, anon, authenticated;
grant all on table public.generated_document_records to service_role;

-- The bucket is private. Owners receive short-lived signed URLs from a server action.
update storage.buckets
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['application/pdf']
where id = 'generated_documents';

drop policy if exists "Users can upload their generated documents" on storage.objects;
drop policy if exists "Users can read their generated documents" on storage.objects;
drop policy if exists "Users can delete their generated documents" on storage.objects;

-- Durable, multi-instance rate-limit windows.
create table if not exists public.security_rate_limits (
  key_hash text primary key,
  request_count integer not null,
  window_started_at timestamptz not null,
  window_seconds integer not null,
  updated_at timestamptz not null default now(),
  constraint security_rate_limits_count check (request_count >= 0),
  constraint security_rate_limits_window check (window_seconds between 1 and 86400)
);

alter table public.security_rate_limits enable row level security;
alter table public.security_rate_limits force row level security;
revoke all on table public.security_rate_limits from public, anon, authenticated;
grant all on table public.security_rate_limits to service_role;

create or replace function public.consume_security_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.security_rate_limits%rowtype;
  current_time timestamptz := clock_timestamp();
begin
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit configuration';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));
  select * into current_row
  from public.security_rate_limits
  where key_hash = p_key_hash
  for update;

  if not found or current_row.window_started_at + make_interval(secs => current_row.window_seconds) <= current_time then
    insert into public.security_rate_limits(key_hash, request_count, window_started_at, window_seconds, updated_at)
    values (p_key_hash, 1, current_time, p_window_seconds, current_time)
    on conflict (key_hash) do update
      set request_count = 1,
          window_started_at = excluded.window_started_at,
          window_seconds = excluded.window_seconds,
          updated_at = excluded.updated_at
    returning * into current_row;
  else
    update public.security_rate_limits
    set request_count = request_count + 1,
        updated_at = current_time
    where key_hash = p_key_hash
    returning * into current_row;
  end if;

  return query select
    current_row.request_count <= p_limit,
    greatest(p_limit - current_row.request_count, 0),
    current_row.window_started_at + make_interval(secs => current_row.window_seconds);
end;
$$;

revoke all on function public.consume_security_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_security_rate_limit(text, integer, integer) to service_role;

-- Central usage counters support future plan tiers without component-level limits.
create table if not exists public.usage_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  metric text not null,
  period_started_at date not null,
  used bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, metric, period_started_at),
  constraint usage_counters_used check (used >= 0)
);

alter table public.usage_counters enable row level security;
alter table public.usage_counters force row level security;
revoke all on table public.usage_counters from public, anon, authenticated;
grant all on table public.usage_counters to service_role;

create or replace function public.consume_usage_quota(
  p_user_id uuid,
  p_metric text,
  p_amount bigint,
  p_limit bigint,
  p_period_started_at date
)
returns table (allowed boolean, used bigint, remaining bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_used bigint;
begin
  if p_amount < 1 or p_limit < 1 then
    raise exception 'invalid quota configuration';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_metric || ':' || p_period_started_at::text, 0));
  select counters.used into current_used
  from public.usage_counters as counters
  where counters.user_id = p_user_id
    and counters.metric = p_metric
    and counters.period_started_at = p_period_started_at
  for update;

  current_used := coalesce(current_used, 0);
  if current_used + p_amount > p_limit then
    return query select false, current_used, greatest(p_limit - current_used, 0);
    return;
  end if;

  insert into public.usage_counters(user_id, metric, period_started_at, used, updated_at)
  values (p_user_id, p_metric, p_period_started_at, p_amount, clock_timestamp())
  on conflict (user_id, metric, period_started_at) do update
    set used = public.usage_counters.used + excluded.used,
        updated_at = excluded.updated_at
  returning public.usage_counters.used into current_used;

  return query select true, current_used, greatest(p_limit - current_used, 0);
end;
$$;

revoke all on function public.consume_usage_quota(uuid, text, bigint, bigint, date) from public, anon, authenticated;
grant execute on function public.consume_usage_quota(uuid, text, bigint, bigint, date) to service_role;

-- Durable leases prevent parallel expensive work across Vercel instances.
create table if not exists public.security_concurrency_leases (
  key_hash text not null,
  lease_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (key_hash, lease_id)
);

create index if not exists security_concurrency_leases_expiry_idx
  on public.security_concurrency_leases(expires_at);

alter table public.security_concurrency_leases enable row level security;
alter table public.security_concurrency_leases force row level security;
revoke all on table public.security_concurrency_leases from public, anon, authenticated;
grant all on table public.security_concurrency_leases to service_role;

create or replace function public.acquire_security_concurrency(
  p_key_hash text,
  p_lease_id uuid,
  p_limit integer,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  active_count integer;
begin
  if p_limit < 1 or p_ttl_seconds < 1 or p_ttl_seconds > 900 then
    raise exception 'invalid concurrency configuration';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));
  delete from public.security_concurrency_leases
  where key_hash = p_key_hash and expires_at <= clock_timestamp();

  select count(*) into active_count
  from public.security_concurrency_leases
  where key_hash = p_key_hash and expires_at > clock_timestamp();

  if active_count >= p_limit then return false; end if;

  insert into public.security_concurrency_leases(key_hash, lease_id, expires_at)
  values (p_key_hash, p_lease_id, clock_timestamp() + make_interval(secs => p_ttl_seconds));
  return true;
end;
$$;

create or replace function public.release_security_concurrency(
  p_key_hash text,
  p_lease_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.security_concurrency_leases
  where key_hash = p_key_hash and lease_id = p_lease_id;
$$;

revoke all on function public.acquire_security_concurrency(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.release_security_concurrency(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_security_concurrency(text, uuid, integer, integer) to service_role;
grant execute on function public.release_security_concurrency(text, uuid) to service_role;

commit;
