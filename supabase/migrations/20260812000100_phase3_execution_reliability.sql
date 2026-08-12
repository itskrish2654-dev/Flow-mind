begin;

-- Phase 3 keeps workflows as stable identities and stores every executable
-- definition in an immutable version row.
alter table public.workflows
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists current_version_id uuid,
  add column if not exists lifecycle_state text not null default 'active',
  add column if not exists archived_at timestamptz;

alter table public.workflows
  drop constraint if exists workflows_lifecycle_state_check;
alter table public.workflows
  add constraint workflows_lifecycle_state_check
  check (lifecycle_state in ('active', 'disabled', 'archived'));

create table if not exists public.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version_number integer not null,
  compiled_workflow jsonb not null,
  setup_config jsonb not null default '{}'::jsonb,
  change_scope text not null default 'full_replacement',
  change_summary text,
  source_version_id uuid references public.workflow_versions(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint workflow_versions_number_positive check (version_number > 0),
  constraint workflow_versions_definition_object check (jsonb_typeof(compiled_workflow) = 'object'),
  constraint workflow_versions_setup_object check (jsonb_typeof(setup_config) = 'object'),
  constraint workflow_versions_definition_size check (pg_column_size(compiled_workflow) <= 262144),
  constraint workflow_versions_setup_size check (pg_column_size(setup_config) <= 131072),
  constraint workflow_versions_scope_check check (change_scope in (
    'initial', 'presentation', 'form_schema', 'ai_instructions', 'destination',
    'workflow_structure', 'setup', 'full_replacement', 'rollback'
  )),
  unique (workflow_id, version_number),
  unique (workflow_id, id)
);

create index if not exists workflow_versions_owner_workflow_created_idx
  on public.workflow_versions(user_id, workflow_id, version_number desc);

-- Existing mutable definitions become an explicitly-labelled baseline. This
-- does not pretend to reconstruct the definition used by old executions.
insert into public.workflow_versions (
  workflow_id, user_id, version_number, compiled_workflow, setup_config,
  change_scope, change_summary, created_by, created_at
)
select
  workflow.id,
  workflow.user_id,
  1,
  workflow.compiled_steps,
  '{}'::jsonb,
  'initial',
  'Baseline version created during Phase 3 migration.',
  workflow.user_id,
  coalesce(workflow.created_at, now())
from public.workflows as workflow
where workflow.user_id is not null
  and workflow.compiled_steps is not null
  and not exists (
    select 1 from public.workflow_versions as version
    where version.workflow_id = workflow.id
  );

update public.workflows as workflow
set current_version_id = version.id
from public.workflow_versions as version
where version.workflow_id = workflow.id
  and version.version_number = (
    select max(latest.version_number)
    from public.workflow_versions as latest
    where latest.workflow_id = workflow.id
  )
  and workflow.current_version_id is null;

alter table public.workflows
  drop constraint if exists workflows_current_version_id_fkey;
alter table public.workflows
  add constraint workflows_current_version_id_fkey
  foreign key (id, current_version_id)
  references public.workflow_versions(workflow_id, id)
  on delete restrict
  deferrable initially deferred;

alter table public.workflow_versions enable row level security;
alter table public.workflow_versions force row level security;
revoke all on table public.workflow_versions from public, anon, authenticated;
grant select on table public.workflow_versions to authenticated;
grant all on table public.workflow_versions to service_role;

drop policy if exists "Users can view their own workflow versions" on public.workflow_versions;
create policy "Users can view their own workflow versions"
  on public.workflow_versions for select to authenticated
  using ((select auth.uid()) = user_id);

-- Durable execution state is created before any provider call.
alter table public.workflow_executions
  add column if not exists workflow_version_id uuid references public.workflow_versions(id) on delete restrict,
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists trigger_type text,
  add column if not exists trigger_metadata jsonb not null default '{}'::jsonb,
  add column if not exists idempotency_key text,
  add column if not exists status text,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists failure_category text,
  add column if not exists sanitized_metadata jsonb not null default '{}'::jsonb,
  add column if not exists attempt_count integer not null default 1;

update public.workflow_executions as execution
set
  user_id = workflow.user_id,
  trigger_type = coalesce(execution.trigger_type, 'legacy'),
  idempotency_key = coalesce(execution.idempotency_key, 'legacy:' || execution.id::text),
  status = coalesce(
    execution.status,
    case
      when execution.output_data ->> 'status' = 'succeeded' then 'succeeded'
      when execution.output_data ->> 'status' = 'partial' then 'partially_failed'
      else 'failed'
    end
  ),
  started_at = coalesce(execution.started_at, execution.created_at),
  completed_at = coalesce(execution.completed_at, execution.created_at),
  sanitized_metadata = execution.sanitized_metadata || jsonb_build_object(
    'snapshotProvenance', 'legacy_unversioned',
    'snapshotWarning', 'The exact workflow definition used by this historical execution is unknown.'
  )
from public.workflows as workflow
where workflow.id = execution.workflow_id;

alter table public.workflow_executions
  alter column user_id set not null,
  alter column trigger_type set not null,
  alter column idempotency_key set not null,
  alter column status set not null;

alter table public.workflow_executions
  drop constraint if exists workflow_executions_status_check,
  drop constraint if exists workflow_executions_trigger_metadata_object,
  drop constraint if exists workflow_executions_metadata_object,
  drop constraint if exists workflow_executions_attempt_positive;
alter table public.workflow_executions
  add constraint workflow_executions_status_check
    check (status in ('queued', 'running', 'succeeded', 'partially_failed', 'failed', 'cancelled')),
  add constraint workflow_executions_trigger_metadata_object
    check (jsonb_typeof(trigger_metadata) = 'object' and pg_column_size(trigger_metadata) <= 32768),
  add constraint workflow_executions_metadata_object
    check (jsonb_typeof(sanitized_metadata) = 'object' and pg_column_size(sanitized_metadata) <= 65536),
  add constraint workflow_executions_attempt_positive check (attempt_count between 1 and 10);

drop index if exists public.workflow_executions_workflow_idempotency_uidx;
create unique index workflow_executions_workflow_idempotency_uidx
  on public.workflow_executions(workflow_id, idempotency_key);
create index if not exists workflow_executions_owner_created_cursor_idx
  on public.workflow_executions(user_id, workflow_id, created_at desc, id desc);
create index if not exists workflow_executions_stale_running_idx
  on public.workflow_executions(status, started_at)
  where status in ('queued', 'running');

alter table public.workflow_executions
  drop constraint if exists workflow_executions_workflow_id_fkey;
alter table public.workflow_executions
  add constraint workflow_executions_workflow_id_fkey
  foreign key (workflow_id) references public.workflows(id) on delete restrict;

create table if not exists public.workflow_execution_steps (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references public.workflow_executions(id) on delete cascade,
  workflow_version_id uuid not null references public.workflow_versions(id) on delete restrict,
  workflow_step_id text not null,
  step_index integer not null,
  capability_id text not null,
  status text not null default 'pending',
  attempt_number integer not null default 1,
  started_at timestamptz,
  completed_at timestamptz,
  sanitized_input_metadata jsonb not null default '{}'::jsonb,
  sanitized_output_metadata jsonb not null default '{}'::jsonb,
  provider_reference_id text,
  error_category text,
  retryable boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_execution_steps_status_check
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  constraint workflow_execution_steps_attempt_check check (attempt_number between 1 and 10),
  constraint workflow_execution_steps_index_check check (step_index >= 0),
  constraint workflow_execution_steps_input_object
    check (jsonb_typeof(sanitized_input_metadata) = 'object' and pg_column_size(sanitized_input_metadata) <= 32768),
  constraint workflow_execution_steps_output_object
    check (jsonb_typeof(sanitized_output_metadata) = 'object' and pg_column_size(sanitized_output_metadata) <= 65536),
  unique (execution_id, workflow_step_id)
);

create index if not exists workflow_execution_steps_execution_order_idx
  on public.workflow_execution_steps(execution_id, step_index);
alter table public.workflow_execution_steps enable row level security;
alter table public.workflow_execution_steps force row level security;
revoke all on table public.workflow_execution_steps from public, anon, authenticated;
grant select on table public.workflow_execution_steps to authenticated;
grant all on table public.workflow_execution_steps to service_role;

drop policy if exists "Users can view their own execution steps" on public.workflow_execution_steps;
create policy "Users can view their own execution steps"
  on public.workflow_execution_steps for select to authenticated
  using (exists (
    select 1 from public.workflow_executions as execution
    where execution.id = workflow_execution_steps.execution_id
      and execution.user_id = (select auth.uid())
  ));

-- Atomic idempotent creation. Every duplicate gets the same execution ID and
-- the unique index is the final race-condition authority.
create or replace function public.create_execution_once(
  p_workflow_id uuid,
  p_workflow_version_id uuid,
  p_user_id uuid,
  p_trigger_type text,
  p_trigger_metadata jsonb,
  p_idempotency_key text,
  p_input_data jsonb
)
returns table (execution_id uuid, created boolean, execution_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_execution_id uuid;
  v_created boolean := false;
  v_status text;
  v_definition jsonb;
begin
  if p_user_id is null
    or p_workflow_id is null
    or p_workflow_version_id is null
    or char_length(p_idempotency_key) not between 8 and 200
    or char_length(p_trigger_type) not between 1 and 40
    or jsonb_typeof(p_trigger_metadata) <> 'object'
    or jsonb_typeof(p_input_data) <> 'object'
  then
    raise exception 'invalid execution values';
  end if;

  select version.compiled_workflow into v_definition
  from public.workflow_versions as version
  join public.workflows as workflow on workflow.id = version.workflow_id
  where version.id = p_workflow_version_id
    and version.workflow_id = p_workflow_id
    and version.user_id = p_user_id
    and workflow.user_id = p_user_id
    and workflow.lifecycle_state = 'active';

  if v_definition is null then
    raise exception 'workflow is unavailable';
  end if;

  insert into public.workflow_executions (
    workflow_id, workflow_version_id, user_id, trigger_type,
    trigger_metadata, idempotency_key, status, input_data, output_data,
    sanitized_metadata
  ) values (
    p_workflow_id, p_workflow_version_id, p_user_id, p_trigger_type,
    p_trigger_metadata, p_idempotency_key, 'queued', p_input_data, '{}'::jsonb,
    jsonb_build_object('snapshotProvenance', 'immutable_version')
  )
  on conflict (workflow_id, idempotency_key) do nothing
  returning id, status into v_execution_id, v_status;

  if v_execution_id is not null then
    v_created := true;
    insert into public.workflow_execution_steps (
      execution_id, workflow_version_id, workflow_step_id, step_index, capability_id
    )
    select
      v_execution_id,
      p_workflow_version_id,
      coalesce(step.value ->> 'id', 'step-' || (step.ordinality - 1)::text),
      step.ordinality - 1,
      coalesce(step.value ->> 'capabilityId', step.value ->> 'type', 'unknown')
    from jsonb_array_elements(v_definition -> 'steps') with ordinality as step(value, ordinality);
  else
    select existing.id, existing.status into v_execution_id, v_status
    from public.workflow_executions as existing
    where existing.workflow_id = p_workflow_id
      and existing.idempotency_key = p_idempotency_key;
  end if;

  return query select v_execution_id, v_created, v_status;
end;
$$;

revoke all on function public.create_execution_once(uuid, uuid, uuid, text, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_execution_once(uuid, uuid, uuid, text, jsonb, text, jsonb)
  to service_role;

-- A retry must be claimed atomically. Only failed/partial executions with an
-- explicitly retryable failed or dependent-skipped step may be resumed.
create or replace function public.claim_execution_retry(
  p_execution_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended('execution-retry:' || p_execution_id::text, 0));
  select status into v_status
  from public.workflow_executions
  where id = p_execution_id and user_id = p_user_id
  for update;

  if v_status not in ('failed', 'partially_failed') then return false; end if;
  if not exists (
    select 1 from public.workflow_execution_steps
    where execution_id = p_execution_id
      and status = 'failed'
      and retryable is true
  ) then return false; end if;

  update public.workflow_execution_steps
  set status = 'pending', attempt_number = attempt_number + 1,
      started_at = null, completed_at = null, error_category = null,
      retryable = null, updated_at = now()
  where execution_id = p_execution_id
    and ((status = 'failed' and retryable is true) or status = 'skipped')
    and attempt_number < 10;

  update public.workflow_executions
  set status = 'queued', started_at = null, completed_at = null,
      failure_category = null, attempt_count = attempt_count + 1
  where id = p_execution_id and user_id = p_user_id and attempt_count < 10;
  return found;
end;
$$;
revoke all on function public.claim_execution_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_execution_retry(uuid, uuid) to service_role;

-- Optimistic, serialized version creation prevents simultaneous edits from
-- silently winning over one another.
create or replace function public.create_workflow_version(
  p_workflow_id uuid,
  p_user_id uuid,
  p_expected_version_id uuid,
  p_compiled_workflow jsonb,
  p_setup_config jsonb,
  p_change_scope text,
  p_change_summary text,
  p_source_version_id uuid default null
)
returns table (version_id uuid, version_number integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current uuid;
  v_number integer;
  v_version_id uuid;
begin
  if jsonb_typeof(p_compiled_workflow) <> 'object'
    or jsonb_typeof(p_setup_config) <> 'object'
    or p_change_scope not in (
      'presentation', 'form_schema', 'ai_instructions', 'destination',
      'workflow_structure', 'setup', 'full_replacement', 'rollback'
    )
  then
    raise exception 'invalid version values';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workflow-version:' || p_workflow_id::text, 0));
  select current_version_id into v_current
  from public.workflows
  where id = p_workflow_id and user_id = p_user_id and lifecycle_state <> 'archived'
  for update;

  if v_current is null or v_current <> p_expected_version_id then
    raise exception 'workflow version conflict';
  end if;
  if p_source_version_id is not null and not exists (
    select 1 from public.workflow_versions
    where id = p_source_version_id and workflow_id = p_workflow_id and user_id = p_user_id
  ) then
    raise exception 'invalid source version';
  end if;

  select coalesce(max(existing.version_number), 0) + 1 into v_number
  from public.workflow_versions as existing
  where existing.workflow_id = p_workflow_id;

  insert into public.workflow_versions (
    workflow_id, user_id, version_number, compiled_workflow, setup_config,
    change_scope, change_summary, source_version_id, created_by
  ) values (
    p_workflow_id, p_user_id, v_number, p_compiled_workflow, p_setup_config,
    p_change_scope, left(nullif(trim(p_change_summary), ''), 300), p_source_version_id, p_user_id
  ) returning id into v_version_id;

  update public.workflows
  set current_version_id = v_version_id,
      compiled_steps = p_compiled_workflow,
      name = left(coalesce(p_compiled_workflow ->> 'workflowName', name), 80),
      updated_at = now()
  where id = p_workflow_id and user_id = p_user_id;

  return query select v_version_id, v_number;
end;
$$;

revoke all on function public.create_workflow_version(uuid, uuid, uuid, jsonb, jsonb, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_workflow_version(uuid, uuid, uuid, jsonb, jsonb, text, text, uuid)
  to service_role;

create or replace function public.create_versioned_workflow_with_quota(
  p_user_id uuid,
  p_name text,
  p_prompt text,
  p_compiled_workflow jsonb,
  p_setup_config jsonb,
  p_limit integer
)
returns table (workflow_id uuid, version_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
  v_workflow_id uuid;
  v_version_id uuid;
begin
  if p_limit < 1 or p_limit > 100000
    or p_user_id is null
    or char_length(p_name) not between 1 and 80
    or char_length(p_prompt) not between 1 and 10000
    or jsonb_typeof(p_compiled_workflow) <> 'object'
    or jsonb_typeof(p_setup_config) <> 'object'
  then
    raise exception 'invalid workflow values';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workflow-quota:' || p_user_id::text, 0));
  select count(*) into v_count from public.workflows
  where user_id = p_user_id and lifecycle_state <> 'archived';
  if v_count >= p_limit then return; end if;

  insert into public.workflows (
    user_id, name, prompt, compiled_steps, public_form_enabled,
    published_at, lifecycle_state
  ) values (
    p_user_id, p_name, p_prompt, p_compiled_workflow, false, null, 'active'
  ) returning id into v_workflow_id;

  insert into public.workflow_versions (
    workflow_id, user_id, version_number, compiled_workflow, setup_config,
    change_scope, change_summary, created_by
  ) values (
    v_workflow_id, p_user_id, 1, p_compiled_workflow, p_setup_config,
    'initial', 'Initial workflow version.', p_user_id
  ) returning id into v_version_id;

  update public.workflows set current_version_id = v_version_id where id = v_workflow_id;
  return query select v_workflow_id, v_version_id;
end;
$$;

revoke all on function public.create_versioned_workflow_with_quota(uuid, text, text, jsonb, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.create_versioned_workflow_with_quota(uuid, text, text, jsonb, jsonb, integer)
  to service_role;

-- A small reconciliation primitive prevents abandoned running records from
-- remaining misleading forever. It is intentionally service-only.
create or replace function public.fail_stale_executions(p_older_than timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  update public.workflow_execution_steps
  set status = 'failed', completed_at = now(), updated_at = now(),
      error_category = 'interrupted', retryable = true
  where status = 'running' and started_at < p_older_than;

  update public.workflow_executions
  set status = case when exists (
        select 1 from public.workflow_execution_steps as step
        where step.execution_id = workflow_executions.id and step.status = 'succeeded'
      ) then 'partially_failed' else 'failed' end,
      completed_at = now(), failure_category = 'interrupted',
      sanitized_metadata = sanitized_metadata || jsonb_build_object(
        'reconciledAt', now(), 'message', 'Execution interrupted before completion.'
      )
  where status in ('queued', 'running')
    and coalesce(started_at, created_at) < p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.fail_stale_executions(timestamptz) from public, anon, authenticated;
grant execute on function public.fail_stale_executions(timestamptz) to service_role;

-- Publication reads the current immutable definition and rejects disabled or
-- archived workflow identities.
create or replace function public.is_public_workflow(p_workflow_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workflows as workflow
    where workflow.id = p_workflow_id
      and workflow.public_form_enabled
      and workflow.lifecycle_state = 'active'
      and workflow.current_version_id is not null
  );
$$;

drop function if exists public.get_public_workflow(uuid);
create function public.get_public_workflow(p_workflow_id uuid)
returns table (
  id uuid, name text, workflow_name text, summary text,
  public_form jsonb, challenge_mode text
)
language sql stable security definer set search_path = ''
as $$
  select
    workflow.id,
    workflow.name,
    coalesce(version.compiled_workflow ->> 'workflowName', workflow.name),
    coalesce(version.compiled_workflow ->> 'summary', 'Submit information to this FlowMind automation.'),
    version.compiled_workflow -> 'publicForm',
    workflow.public_form_challenge_mode
  from public.workflows as workflow
  join public.workflow_versions as version on version.id = workflow.current_version_id
  where workflow.id = p_workflow_id
    and workflow.public_form_enabled
    and workflow.lifecycle_state = 'active'
  limit 1;
$$;
revoke all on function public.get_public_workflow(uuid) from public;
grant execute on function public.get_public_workflow(uuid) to anon, authenticated;

commit;
