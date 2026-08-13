begin;

-- Service-owned telemetry deliberately stores only bounded, sanitized metadata.
-- Browser roles cannot read or write these tables.
create table if not exists public.operational_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default clock_timestamp(),
  level text not null check (level in ('info', 'warn', 'error')),
  event text not null check (char_length(event) between 1 and 120),
  request_id text check (request_id is null or char_length(request_id) <= 100),
  user_id_hash text check (user_id_hash is null or char_length(user_id_hash) <= 128),
  workflow_id uuid,
  workflow_version_id uuid,
  execution_id uuid,
  step_id text check (step_id is null or char_length(step_id) <= 100),
  capability text check (capability is null or char_length(capability) <= 100),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  status text check (status is null or char_length(status) <= 60),
  error_category text check (error_category is null or char_length(error_category) <= 100),
  environment text not null default 'unknown',
  release text check (release is null or char_length(release) <= 100),
  metadata jsonb not null default '{}'::jsonb,
  constraint operational_events_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists operational_events_time_idx
  on public.operational_events(occurred_at desc);
create index if not exists operational_events_failure_idx
  on public.operational_events(event, occurred_at desc)
  where level = 'error';
create index if not exists operational_events_execution_idx
  on public.operational_events(execution_id, occurred_at desc)
  where execution_id is not null;

alter table public.operational_events enable row level security;
alter table public.operational_events force row level security;
revoke all on table public.operational_events from public, anon, authenticated;
grant all on table public.operational_events to service_role;

create table if not exists public.product_analytics_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default clock_timestamp(),
  event_name text not null check (char_length(event_name) between 1 and 100),
  user_id_hash text check (user_id_hash is null or char_length(user_id_hash) <= 128),
  anonymous_id_hash text check (anonymous_id_hash is null or char_length(anonymous_id_hash) <= 128),
  workflow_id uuid,
  environment text not null default 'unknown',
  properties jsonb not null default '{}'::jsonb,
  constraint product_analytics_properties_object check (jsonb_typeof(properties) = 'object')
);

create index if not exists product_analytics_event_time_idx
  on public.product_analytics_events(event_name, occurred_at desc);
create index if not exists product_analytics_user_time_idx
  on public.product_analytics_events(user_id_hash, occurred_at desc)
  where user_id_hash is not null;

alter table public.product_analytics_events enable row level security;
alter table public.product_analytics_events force row level security;
revoke all on table public.product_analytics_events from public, anon, authenticated;
grant all on table public.product_analytics_events to service_role;

create table if not exists public.operational_maintenance_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null default 'phase6-maintenance',
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  status text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  metrics jsonb not null default '{}'::jsonb,
  error_category text,
  constraint operational_maintenance_metrics_object check (jsonb_typeof(metrics) = 'object')
);

create index if not exists operational_maintenance_runs_time_idx
  on public.operational_maintenance_runs(started_at desc);
alter table public.operational_maintenance_runs enable row level security;
alter table public.operational_maintenance_runs force row level security;
revoke all on table public.operational_maintenance_runs from public, anon, authenticated;
grant all on table public.operational_maintenance_runs to service_role;

-- One atomic, overlap-safe maintenance primitive. The advisory lock is scoped
-- to this transaction and duplicate cron invocations become no-op runs.
create or replace function public.run_operational_maintenance(
  p_stale_before timestamptz,
  p_rate_limit_retention_before timestamptz,
  p_deletion_job_stale_before timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_stale_executions integer := 0;
  v_rate_limits integer := 0;
  v_expired_leases integer := 0;
  v_stale_deletions integer := 0;
begin
  if p_stale_before is null
    or p_rate_limit_retention_before is null
    or p_deletion_job_stale_before is null then
    raise exception 'invalid maintenance boundary';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('flowmind:phase6-maintenance', 0)) then
    insert into public.operational_maintenance_runs(status, completed_at, metrics)
    values ('skipped', clock_timestamp(), jsonb_build_object('reason', 'overlapping_run'))
    returning id into v_run_id;
    return jsonb_build_object('runId', v_run_id, 'status', 'skipped');
  end if;

  insert into public.operational_maintenance_runs(status)
  values ('running') returning id into v_run_id;

  select public.fail_stale_executions(p_stale_before) into v_stale_executions;

  delete from public.security_rate_limits
  where window_started_at + make_interval(secs => window_seconds) < p_rate_limit_retention_before;
  get diagnostics v_rate_limits = row_count;

  delete from public.security_concurrency_leases
  where expires_at < clock_timestamp();
  get diagnostics v_expired_leases = row_count;

  update public.account_deletion_jobs
  set state = 'failed',
      failure_code = 'interrupted_deletion_job',
      updated_at = clock_timestamp()
  where state = 'processing'
    and updated_at < p_deletion_job_stale_before;
  get diagnostics v_stale_deletions = row_count;

  update public.operational_maintenance_runs
  set status = 'succeeded',
      completed_at = clock_timestamp(),
      metrics = jsonb_build_object(
        'staleExecutions', v_stale_executions,
        'expiredRateLimits', v_rate_limits,
        'expiredConcurrencyLeases', v_expired_leases,
        'staleDeletionJobs', v_stale_deletions
      )
  where id = v_run_id;

  return jsonb_build_object(
    'runId', v_run_id,
    'status', 'succeeded',
    'staleExecutions', v_stale_executions,
    'expiredRateLimits', v_rate_limits,
    'expiredConcurrencyLeases', v_expired_leases,
    'staleDeletionJobs', v_stale_deletions
  );
exception when others then
  if v_run_id is not null then
    update public.operational_maintenance_runs
    set status = 'failed', completed_at = clock_timestamp(), error_category = 'maintenance_failed'
    where id = v_run_id;
  end if;
  raise;
end;
$$;

revoke all on function public.run_operational_maintenance(timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_operational_maintenance(timestamptz, timestamptz, timestamptz)
  to service_role;

commit;
