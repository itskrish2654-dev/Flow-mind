begin;

create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create table public.workflow_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  workflow_version_id uuid not null references public.workflow_versions(id) on delete cascade,
  status text not null default 'active',
  schedule_definition jsonb not null,
  human_label text not null,
  timezone text not null,
  anchor_at timestamptz not null default now(),
  next_run_at timestamptz,
  last_scheduled_for timestamptz,
  last_dispatched_at timestamptz,
  last_error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_schedules_identity_unique unique (workflow_id),
  constraint workflow_schedules_status_check check (status in ('active', 'disabled', 'completed', 'error')),
  constraint workflow_schedules_definition_check check (jsonb_typeof(schedule_definition) = 'object' and pg_column_size(schedule_definition) <= 16384),
  constraint workflow_schedules_label_check check (char_length(human_label) between 1 and 160),
  constraint workflow_schedules_timezone_check check (char_length(timezone) between 1 and 100)
);

create index workflow_schedules_due_idx on public.workflow_schedules(next_run_at, id) where status = 'active';
create index workflow_schedules_owner_idx on public.workflow_schedules(user_id, updated_at desc);
alter table public.workflow_schedules enable row level security;
alter table public.workflow_schedules force row level security;
revoke all on table public.workflow_schedules from public, anon, authenticated;
grant select on table public.workflow_schedules to authenticated;
grant all on table public.workflow_schedules to service_role;
create policy "Users can view their own schedules" on public.workflow_schedules
  for select to authenticated using ((select auth.uid()) = user_id);

create table public.workflow_schedule_occurrences (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.workflow_schedules(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  workflow_version_id uuid not null references public.workflow_versions(id) on delete cascade,
  scheduled_for timestamptz not null,
  status text not null,
  execution_id uuid references public.workflow_executions(id) on delete set null,
  missed_earlier_count integer not null default 0,
  reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint workflow_schedule_occurrences_unique unique (schedule_id, scheduled_for),
  constraint workflow_schedule_occurrences_status_check check (status in ('claimed', 'running', 'succeeded', 'failed', 'missed', 'duplicate')),
  constraint workflow_schedule_occurrences_missed_check check (missed_earlier_count between 0 and 500),
  constraint workflow_schedule_occurrences_reason_check check (reason is null or char_length(reason) <= 300)
);

create index workflow_schedule_occurrences_owner_idx on public.workflow_schedule_occurrences(user_id, created_at desc);
alter table public.workflow_schedule_occurrences enable row level security;
alter table public.workflow_schedule_occurrences force row level security;
revoke all on table public.workflow_schedule_occurrences from public, anon, authenticated;
grant select on table public.workflow_schedule_occurrences to authenticated;
grant all on table public.workflow_schedule_occurrences to service_role;
create policy "Users can view their own schedule occurrences" on public.workflow_schedule_occurrences
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.claim_schedule_occurrence(
  p_schedule_id uuid,
  p_expected_next_run_at timestamptz,
  p_scheduled_for timestamptz,
  p_next_run_at timestamptz,
  p_missed_earlier_count integer,
  p_should_execute boolean
)
returns table (
  occurrence_id uuid,
  claimed boolean,
  user_id uuid,
  workflow_id uuid,
  workflow_version_id uuid,
  schedule_definition jsonb,
  timezone text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.workflow_schedules%rowtype;
  v_occurrence_id uuid;
begin
  if p_schedule_id is null or p_expected_next_run_at is null or p_scheduled_for is null
    or p_missed_earlier_count not between 0 and 500 then
    raise exception 'invalid schedule claim';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workflow-schedule:' || p_schedule_id::text, 0));
  select schedule.* into v_schedule
  from public.workflow_schedules as schedule
  join public.workflows as workflow on workflow.id = schedule.workflow_id
  where schedule.id = p_schedule_id
    and schedule.status = 'active'
    and schedule.next_run_at = p_expected_next_run_at
    and workflow.user_id = schedule.user_id
    and workflow.lifecycle_state = 'active'
    and workflow.public_form_enabled is true
  for update of schedule;
  if not found then return; end if;

  insert into public.workflow_schedule_occurrences (
    schedule_id, user_id, workflow_id, workflow_version_id, scheduled_for,
    status, missed_earlier_count, reason, completed_at
  ) values (
    v_schedule.id, v_schedule.user_id, v_schedule.workflow_id,
    v_schedule.workflow_version_id, p_scheduled_for,
    case when p_should_execute then 'claimed' else 'missed' end,
    p_missed_earlier_count,
    case when p_should_execute then null else 'Occurrence was outside the bounded 15-minute recovery window.' end,
    case when p_should_execute then null else now() end
  )
  on conflict (schedule_id, scheduled_for) do nothing
  returning id into v_occurrence_id;

  if v_occurrence_id is null then return query select null::uuid, false, v_schedule.user_id, v_schedule.workflow_id, v_schedule.workflow_version_id, v_schedule.schedule_definition, v_schedule.timezone; return; end if;
  update public.workflow_schedules set
    next_run_at = p_next_run_at,
    last_scheduled_for = p_scheduled_for,
    status = case when p_next_run_at is null then 'completed' else status end,
    updated_at = now()
  where id = v_schedule.id;
  return query select v_occurrence_id, true, v_schedule.user_id, v_schedule.workflow_id, v_schedule.workflow_version_id, v_schedule.schedule_definition, v_schedule.timezone;
end;
$$;
revoke all on function public.claim_schedule_occurrence(uuid, timestamptz, timestamptz, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.claim_schedule_occurrence(uuid, timestamptz, timestamptz, timestamptz, integer, boolean) to service_role;

create table public.connector_capability_requests (
  id uuid primary key default gen_random_uuid(),
  requester_hash text not null,
  user_id uuid references auth.users(id) on delete set null,
  requested_provider text not null,
  requested_capability text,
  source text not null,
  request_count integer not null default 1,
  first_requested_at timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  constraint connector_capability_requests_provider_check check (requested_provider ~ '^[a-z0-9][a-z0-9 _.-]{0,79}$'),
  constraint connector_capability_requests_capability_check check (requested_capability is null or requested_capability ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  constraint connector_capability_requests_source_check check (source in ('homepage_demo', 'workflow_builder', 'connections_page')),
  constraint connector_capability_requests_count_check check (request_count between 1 and 10000)
);
create unique index connector_capability_requests_requester_unique
  on public.connector_capability_requests(requester_hash, requested_provider, coalesce(requested_capability, ''), source);
alter table public.connector_capability_requests enable row level security;
alter table public.connector_capability_requests force row level security;
revoke all on table public.connector_capability_requests from public, anon, authenticated;
grant all on table public.connector_capability_requests to service_role;

create view public.connector_request_demand_report with (security_invoker = true) as
select requested_provider, requested_capability, count(*)::bigint as unique_requesters,
       sum(request_count)::bigint as total_requests, max(last_requested_at) as last_requested_at
from public.connector_capability_requests
group by requested_provider, requested_capability;
revoke all on table public.connector_request_demand_report from public, anon, authenticated;
grant select on table public.connector_request_demand_report to service_role;

create or replace function public.record_connector_capability_request(
  p_requester_hash text,
  p_user_id uuid,
  p_requested_provider text,
  p_requested_capability text,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(p_requester_hash) <> 64
    or p_requested_provider !~ '^[a-z0-9][a-z0-9 _.-]{0,79}$'
    or (p_requested_capability is not null and p_requested_capability !~ '^[a-z0-9][a-z0-9_.-]{0,79}$')
    or p_source not in ('homepage_demo', 'workflow_builder', 'connections_page') then
    raise exception 'invalid connector request';
  end if;
  if p_user_id is not null and not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'invalid requester';
  end if;
  insert into public.connector_capability_requests (
    requester_hash, user_id, requested_provider, requested_capability, source
  ) values (
    p_requester_hash, p_user_id, p_requested_provider, p_requested_capability, p_source
  ) on conflict (requester_hash, requested_provider, (coalesce(requested_capability, '')), source)
  do update set request_count = least(public.connector_capability_requests.request_count + 1, 10000), last_requested_at = now();
end;
$$;
revoke all on function public.record_connector_capability_request(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_connector_capability_request(text, uuid, text, text, text) to service_role;

create or replace function public.configure_schedule_dispatch(p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if char_length(p_secret) < 32 then raise exception 'invalid dispatch secret'; end if;
  select id into v_id from vault.secrets where name = 'crazyloops_schedule_dispatch_secret';
  if v_id is null then
    perform vault.create_secret(p_secret, 'crazyloops_schedule_dispatch_secret', 'CrazyLoops schedule dispatch bearer secret');
  else
    perform vault.update_secret(v_id, p_secret, 'crazyloops_schedule_dispatch_secret', 'CrazyLoops schedule dispatch bearer secret');
  end if;
end;
$$;
revoke all on function public.configure_schedule_dispatch(text) from public, anon, authenticated;
grant execute on function public.configure_schedule_dispatch(text) to service_role;

do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'crazyloops-schedule-dispatch';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule(
    'crazyloops-schedule-dispatch',
    '* * * * *',
    $job$
      select net.http_post(
        url := 'https://www.crazy-loops.com/api/operations/schedules',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'crazyloops_schedule_dispatch_secret' limit 1), '')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
      )
    $job$
  );
end;
$$;

commit;
