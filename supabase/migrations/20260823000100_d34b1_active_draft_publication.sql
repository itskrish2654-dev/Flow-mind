begin;

-- The current version is the customer's editable draft. The published version
-- is the immutable definition used by production triggers until an explicit,
-- successful publication switches it.
alter table public.workflows
  add column if not exists published_version_id uuid;

update public.workflows
set published_version_id = current_version_id
where public_form_enabled is true
  and published_version_id is null;

alter table public.workflows
  drop constraint if exists workflows_published_version_id_fkey;
alter table public.workflows
  add constraint workflows_published_version_id_fkey
  foreign key (id, published_version_id)
  references public.workflow_versions(workflow_id, id)
  on delete restrict
  deferrable initially deferred;

create or replace function public.is_public_workflow(p_workflow_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.workflows as workflow
    where workflow.id = p_workflow_id
      and workflow.public_form_enabled
      and workflow.lifecycle_state = 'active'
      and workflow.published_version_id is not null
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
  select workflow.id, workflow.name,
    coalesce(version.compiled_workflow ->> 'workflowName', workflow.name),
    coalesce(version.compiled_workflow ->> 'summary', 'Submit information to this CrazyLoops automation.'),
    version.compiled_workflow -> 'publicForm', workflow.public_form_challenge_mode
  from public.workflows as workflow
  join public.workflow_versions as version on version.id = workflow.published_version_id
  where workflow.id = p_workflow_id
    and workflow.public_form_enabled
    and workflow.lifecycle_state = 'active'
    and version.compiled_workflow ? 'publicForm'
    and jsonb_typeof(version.compiled_workflow -> 'publicForm') = 'object'
  limit 1;
$$;
revoke all on function public.get_public_workflow(uuid) from public;
grant execute on function public.get_public_workflow(uuid) to anon, authenticated;

-- Publication is one database transaction: the production pointer, connector
-- subscriptions, and schedule either all switch to the validated draft or all
-- remain on the previously published version.
create or replace function public.publish_workflow_version(
  p_workflow_id uuid,
  p_user_id uuid,
  p_expected_current_version_id uuid,
  p_publish boolean,
  p_challenge_mode text,
  p_subscriptions jsonb default '[]'::jsonb,
  p_schedule jsonb default null
)
returns table (published boolean, published_version_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_version_id uuid;
  v_subscription jsonb;
  v_subscription_count integer;
  v_schedule_anchor timestamptz;
  v_schedule_next_run timestamptz;
begin
  if p_workflow_id is null
    or p_user_id is null
    or p_expected_current_version_id is null
    or p_challenge_mode not in ('honeypot', 'turnstile')
    or jsonb_typeof(p_subscriptions) <> 'array'
    or jsonb_array_length(p_subscriptions) > 20
    or (p_schedule is not null and jsonb_typeof(p_schedule) <> 'object')
  then
    raise exception 'invalid workflow publication request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('workflow-publication:' || p_workflow_id::text, 0));
  select workflow.current_version_id into v_current_version_id
  from public.workflows as workflow
  where workflow.id = p_workflow_id
    and workflow.user_id = p_user_id
    and workflow.lifecycle_state = 'active'
  for update;

  if v_current_version_id is null or v_current_version_id <> p_expected_current_version_id then
    raise exception 'workflow version conflict';
  end if;

  if not p_publish then
    update public.connector_subscriptions
    set status = 'revoked', updated_at = clock_timestamp()
    where workflow_id = p_workflow_id
      and user_id = p_user_id
      and status = 'active';

    update public.workflow_schedules
    set status = 'disabled', next_run_at = null, updated_at = clock_timestamp()
    where workflow_id = p_workflow_id
      and user_id = p_user_id
      and status = 'active';

    update public.workflows
    set public_form_enabled = false,
        published_at = null,
        updated_at = clock_timestamp()
    where id = p_workflow_id and user_id = p_user_id;

    return query select false, workflow.published_version_id
    from public.workflows as workflow
    where workflow.id = p_workflow_id and workflow.user_id = p_user_id;
    return;
  end if;

  if not exists (
    select 1 from public.workflow_versions as version
    where version.id = v_current_version_id
      and version.workflow_id = p_workflow_id
      and version.user_id = p_user_id
  ) then
    raise exception 'publishable workflow version not found';
  end if;

  select count(*) into v_subscription_count
  from (
    select distinct
      item ->> 'connectorId' as connector_id,
      item ->> 'operationKey' as operation_key
    from jsonb_array_elements(p_subscriptions) as item
  ) as unique_subscriptions;
  if v_subscription_count <> jsonb_array_length(p_subscriptions) then
    raise exception 'duplicate connector subscription';
  end if;

  -- Revocation is invisible until commit and rolls back if any replacement
  -- subscription or schedule fails validation/insertion below.
  update public.connector_subscriptions
  set status = 'revoked', updated_at = clock_timestamp()
  where workflow_id = p_workflow_id
    and user_id = p_user_id
    and status = 'active';

  for v_subscription in select value from jsonb_array_elements(p_subscriptions)
  loop
    if coalesce(v_subscription ->> 'id', '') = ''
      or coalesce(v_subscription ->> 'connectorId', '') = ''
      or coalesce(v_subscription ->> 'operationKey', '') = ''
      or coalesce((v_subscription ->> 'operationVersion')::integer, 0) <= 0
      or coalesce(v_subscription ->> 'endpointTokenHash', '') = ''
      or jsonb_typeof(coalesce(v_subscription -> 'safeMetadata', '{}'::jsonb)) <> 'object'
    then
      raise exception 'invalid connector subscription';
    end if;

    if nullif(v_subscription ->> 'connectionId', '') is not null and not exists (
      select 1 from public.connector_connections as connection
      where connection.id = (v_subscription ->> 'connectionId')::uuid
        and connection.user_id = p_user_id
        and connection.status = 'connected'
    ) then
      raise exception 'connector connection is unavailable';
    end if;

    insert into public.connector_subscriptions (
      id, user_id, workflow_id, workflow_version_id, connection_id,
      connector_id, operation_key, operation_version, provider_subscription_id,
      endpoint_token_hash, status, cursor_value, renew_after, expires_at,
      last_error_category, safe_metadata, updated_at
    ) values (
      (v_subscription ->> 'id')::uuid,
      p_user_id,
      p_workflow_id,
      v_current_version_id,
      nullif(v_subscription ->> 'connectionId', '')::uuid,
      v_subscription ->> 'connectorId',
      v_subscription ->> 'operationKey',
      (v_subscription ->> 'operationVersion')::integer,
      nullif(v_subscription ->> 'providerSubscriptionId', ''),
      v_subscription ->> 'endpointTokenHash',
      'active',
      nullif(v_subscription ->> 'cursorValue', ''),
      nullif(v_subscription ->> 'renewAfter', '')::timestamptz,
      nullif(v_subscription ->> 'expiresAt', '')::timestamptz,
      null,
      coalesce(v_subscription -> 'safeMetadata', '{}'::jsonb),
      clock_timestamp()
    )
    on conflict (workflow_version_id, connector_id, operation_key)
    do update set
      connection_id = excluded.connection_id,
      operation_version = excluded.operation_version,
      provider_subscription_id = excluded.provider_subscription_id,
      endpoint_token_hash = excluded.endpoint_token_hash,
      status = 'active',
      cursor_value = excluded.cursor_value,
      renew_after = excluded.renew_after,
      expires_at = excluded.expires_at,
      last_error_category = null,
      safe_metadata = excluded.safe_metadata,
      updated_at = clock_timestamp();
  end loop;

  if p_schedule is null then
    update public.workflow_schedules
    set status = 'disabled', next_run_at = null, updated_at = clock_timestamp()
    where workflow_id = p_workflow_id and user_id = p_user_id;
  else
    if coalesce(p_schedule ->> 'humanLabel', '') = ''
      or coalesce(p_schedule ->> 'timezone', '') = ''
      or jsonb_typeof(p_schedule -> 'definition') <> 'object'
      or nullif(p_schedule ->> 'anchorAt', '') is null
      or nullif(p_schedule ->> 'nextRunAt', '') is null
    then
      raise exception 'invalid workflow schedule';
    end if;
    v_schedule_anchor := (p_schedule ->> 'anchorAt')::timestamptz;
    v_schedule_next_run := (p_schedule ->> 'nextRunAt')::timestamptz;

    insert into public.workflow_schedules (
      user_id, workflow_id, workflow_version_id, status, schedule_definition,
      human_label, timezone, anchor_at, next_run_at, last_error_category, updated_at
    ) values (
      p_user_id, p_workflow_id, v_current_version_id, 'active',
      p_schedule -> 'definition', left(p_schedule ->> 'humanLabel', 160),
      left(p_schedule ->> 'timezone', 100), v_schedule_anchor,
      v_schedule_next_run, null, clock_timestamp()
    )
    on conflict (workflow_id) do update set
      workflow_version_id = excluded.workflow_version_id,
      status = 'active',
      schedule_definition = excluded.schedule_definition,
      human_label = excluded.human_label,
      timezone = excluded.timezone,
      anchor_at = excluded.anchor_at,
      next_run_at = excluded.next_run_at,
      last_error_category = null,
      updated_at = clock_timestamp();
  end if;

  update public.workflows
  set published_version_id = v_current_version_id,
      public_form_enabled = true,
      public_form_challenge_mode = p_challenge_mode,
      published_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_workflow_id and user_id = p_user_id;

  return query select true, v_current_version_id;
end;
$$;

revoke all on function public.publish_workflow_version(uuid, uuid, uuid, boolean, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.publish_workflow_version(uuid, uuid, uuid, boolean, text, jsonb, jsonb)
  to service_role;

-- Account cleanup must clear both version pointers before immutable versions
-- are deleted under the composite foreign keys.
create or replace function public.cleanup_account_data(p_job_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_owner uuid;
begin
  if p_job_id is null or p_user_id is null then
    raise exception 'invalid account cleanup request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('account-delete:' || p_user_id::text, 0));
  select user_id into job_owner
  from public.account_deletion_jobs
  where id = p_job_id
    and state in ('requested', 'processing', 'failed')
  for update;

  if job_owner is null or job_owner <> p_user_id then
    raise exception 'account deletion job not found';
  end if;

  update public.account_deletion_jobs
  set state = 'processing',
      started_at = coalesce(started_at, clock_timestamp()),
      updated_at = clock_timestamp(),
      retry_count = retry_count + 1,
      failure_code = null
  where id = p_job_id;

  update public.workflows
  set public_form_enabled = false,
      published_at = null,
      lifecycle_state = 'disabled',
      current_version_id = null,
      published_version_id = null,
      updated_at = clock_timestamp()
  where user_id = p_user_id;

  delete from public.workflow_execution_steps
  where execution_id in (
    select id from public.workflow_executions where user_id = p_user_id
  );
  delete from public.workflow_executions where user_id = p_user_id;
  delete from public.workflow_credentials where user_id = p_user_id;
  delete from public.generated_document_records where user_id = p_user_id;
  delete from public.usage_counters where user_id = p_user_id;
  delete from public.workflow_versions where user_id = p_user_id;
  delete from public.workflows where user_id = p_user_id;

  update public.account_deletion_jobs
  set updated_at = clock_timestamp()
  where id = p_job_id;

  return true;
end;
$$;
revoke all on function public.cleanup_account_data(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cleanup_account_data(uuid, uuid) to service_role;

commit;
