begin;

create table public.action_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requester_user_id uuid not null,
  approval_request_id uuid not null unique references public.approval_requests(id) on delete cascade,
  work_item_id uuid not null unique references public.work_items(id) on delete cascade,
  source_message_id uuid,
  connection_id uuid references public.connector_connections(id) on delete set null,
  capability_id text not null,
  connector_id text not null,
  operation_key text not null,
  operation_version integer not null,
  idempotency_key text not null,
  status text not null default 'pending_approval',
  claim_token uuid,
  claimed_at timestamptz,
  attempt_count integer not null default 0,
  acknowledged boolean not null default false,
  externally_delivered boolean not null default false,
  provider_reference_id text,
  result_summary text,
  failure_category text,
  failure_message text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint action_executions_membership_fkey foreign key (workspace_id, requester_user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade,
  constraint action_executions_capability_check check (capability_id ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  constraint action_executions_connector_check check (connector_id ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  constraint action_executions_operation_check check (operation_key ~ '^[a-z][a-z0-9_.-]{0,79}$' and operation_version > 0),
  constraint action_executions_idempotency_check check (char_length(idempotency_key) between 1 and 180),
  constraint action_executions_status_check check (status in (
    'pending_approval', 'queued', 'executing', 'succeeded', 'failed', 'ambiguous', 'rejected', 'cancelled'
  )),
  constraint action_executions_claim_check check (
    (status = 'executing' and claim_token is not null and claimed_at is not null)
    or status <> 'executing'
  ),
  constraint action_executions_result_check check (
    (status = 'succeeded' and acknowledged and externally_delivered and completed_at is not null and failure_category is null)
    or (status in ('failed', 'ambiguous') and not externally_delivered and completed_at is not null and failure_category is not null)
    or (status in ('rejected', 'cancelled') and not acknowledged and not externally_delivered and completed_at is not null)
    or status in ('pending_approval', 'queued', 'executing')
  )
);

create unique index action_executions_idempotency_idx
  on public.action_executions(workspace_id, idempotency_key);
create index action_executions_requester_status_created_idx
  on public.action_executions(workspace_id, requester_user_id, status, created_at desc);
create index action_executions_connection_idx on public.action_executions(connection_id);
create index action_executions_source_message_idx on public.action_executions(source_message_id);

alter table public.action_executions enable row level security;
alter table public.action_executions force row level security;
revoke all on table public.action_executions from public, anon, authenticated;
grant select on table public.action_executions to authenticated;
grant select, insert, update, delete on table public.action_executions to service_role;

create policy action_executions_requester_select on public.action_executions
  for select to authenticated using (
    requester_user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = action_executions.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

create function public.guard_action_execution_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if row(new.id, new.workspace_id, new.requester_user_id, new.approval_request_id,
    new.work_item_id, new.source_message_id, new.connection_id, new.capability_id,
    new.connector_id, new.operation_key, new.operation_version, new.idempotency_key,
    new.created_at)
    is distinct from
    row(old.id, old.workspace_id, old.requester_user_id, old.approval_request_id,
    old.work_item_id, old.source_message_id, old.connection_id, old.capability_id,
    old.connector_id, old.operation_key, old.operation_version, old.idempotency_key,
    old.created_at)
  then raise exception 'Action execution identity is immutable'; end if;
  return new;
end;
$$;

create trigger action_execution_update_guard before update on public.action_executions
  for each row execute function public.guard_action_execution_update();

create function public.create_action_approval(
  p_actor_user_id uuid,
  p_source_message_id uuid,
  p_request_key text,
  p_action_title text,
  p_action_summary text,
  p_approval_reason text,
  p_capability_id text,
  p_connector_id text,
  p_operation_key text,
  p_operation_version integer,
  p_connection_id uuid,
  p_action_snapshot jsonb
) returns setof public.action_executions
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_item public.work_items%rowtype;
  v_approval public.approval_requests%rowtype;
  v_existing public.action_executions%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;

  if p_connection_id is not null and not exists (
    select 1 from public.connector_connections as connection
    where connection.id = p_connection_id and connection.user_id = p_actor_user_id
      and connection.workspace_id = v_workspace_id and connection.status = 'connected'
      and connection.connector_id = p_connector_id
  ) then raise exception 'Connection is unavailable'; end if;

  select * into v_existing from public.action_executions
  where workspace_id = v_workspace_id and idempotency_key = p_request_key;
  if found then
    if v_existing.requester_user_id <> p_actor_user_id
      or v_existing.source_message_id is distinct from p_source_message_id
      or v_existing.capability_id <> p_capability_id
      or v_existing.connector_id <> p_connector_id
      or v_existing.operation_key <> p_operation_key
      or v_existing.operation_version <> p_operation_version
      or v_existing.connection_id is distinct from p_connection_id
    then raise exception 'Action idempotency key belongs to another proposal'; end if;
    return query select * from public.action_executions where id = v_existing.id;
    return;
  end if;

  insert into public.work_items (
    workspace_id, assignee_user_id, title, summary, why_it_matters,
    suggested_action, status, priority, source_type, source_id, source_label, dedupe_key
  ) values (
    v_workspace_id, p_actor_user_id, p_action_title, p_action_summary,
    p_approval_reason, 'Review the exact action and approve or reject it.',
    'needs_you', 'normal', 'internal', p_source_message_id::text,
    'Ask CrazyLoops', p_request_key
  ) returning * into v_item;

  select * into strict v_approval from public.create_approval_request(
    p_actor_user_id, v_item.id, p_actor_user_id, 'internal',
    p_source_message_id::text, p_request_key, p_action_title,
    p_action_summary, p_approval_reason, p_capability_id, p_action_snapshot
  );

  return query insert into public.action_executions (
    workspace_id, requester_user_id, approval_request_id, work_item_id,
    source_message_id, connection_id, capability_id, connector_id,
    operation_key, operation_version, idempotency_key
  ) values (
    v_workspace_id, p_actor_user_id, v_approval.id, v_item.id,
    p_source_message_id, p_connection_id, p_capability_id, p_connector_id,
    p_operation_key, p_operation_version, p_request_key
  ) returning *;
end;
$$;

create function public.decide_action_execution(
  p_approval_id uuid, p_actor_user_id uuid, p_decision text,
  p_rejection_reason text default null
) returns setof public.action_executions
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_action public.action_executions%rowtype;
  v_approval public.approval_requests%rowtype;
  v_item public.work_items%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_decision not in ('approved', 'rejected', 'cancelled') then raise exception 'Invalid approval decision'; end if;
  if p_decision <> 'rejected' and p_rejection_reason is not null then raise exception 'Invalid rejection reason'; end if;
  select membership.workspace_id into strict v_workspace_id
    from public.workspace_memberships as membership
    where membership.user_id = p_actor_user_id and membership.is_default;
  select * into strict v_action from public.action_executions
    where approval_request_id = p_approval_id and workspace_id = v_workspace_id for update;
  select * into strict v_item from public.work_items
    where id = v_action.work_item_id and workspace_id = v_workspace_id
      and assignee_user_id = p_actor_user_id for update;
  select * into strict v_approval from public.approval_requests
    where id = p_approval_id and workspace_id = v_workspace_id
      and approver_user_id = p_actor_user_id for update;
  if v_action.status <> 'pending_approval' or v_approval.status <> 'pending'
    or v_item.status <> 'needs_you'
  then raise exception 'Action approval was already decided'; end if;

  update public.approval_requests set status = p_decision,
    decided_by_user_id = p_actor_user_id, decided_at = clock_timestamp(),
    rejection_reason = case when p_decision = 'rejected' then p_rejection_reason else null end,
    updated_at = clock_timestamp()
  where id = p_approval_id;

  if p_decision = 'approved' then
    update public.action_executions set status = 'queued', updated_at = clock_timestamp()
      where id = v_action.id;
    update public.work_items set status = 'waiting', updated_at = clock_timestamp()
      where id = v_item.id;
  else
    update public.action_executions set status = p_decision,
      completed_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = v_action.id;
    update public.work_items set status = 'done', resolved_at = clock_timestamp(),
      updated_at = clock_timestamp() where id = v_item.id;
  end if;
  return query select * from public.action_executions where id = v_action.id;
end;
$$;

create function public.claim_action_execution(
  p_execution_id uuid, p_actor_user_id uuid
) returns setof public.action_executions
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_claim uuid := gen_random_uuid();
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  select membership.workspace_id into strict v_workspace_id
    from public.workspace_memberships as membership
    where membership.user_id = p_actor_user_id and membership.is_default;
  return query update public.action_executions set status = 'executing',
    claim_token = v_claim, claimed_at = clock_timestamp(), attempt_count = attempt_count + 1,
    updated_at = clock_timestamp()
  where id = p_execution_id and workspace_id = v_workspace_id
    and requester_user_id = p_actor_user_id and status = 'queued'
  returning *;
end;
$$;

create function public.complete_action_execution(
  p_execution_id uuid, p_claim_token uuid, p_status text,
  p_acknowledged boolean, p_externally_delivered boolean,
  p_provider_reference_id text, p_result_summary text,
  p_failure_category text, p_failure_message text
) returns setof public.action_executions
language plpgsql security invoker set search_path = '' as $$
declare
  v_action public.action_executions%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_status not in ('succeeded', 'failed', 'ambiguous') then raise exception 'Invalid action result'; end if;
  select * into strict v_action from public.action_executions
    where id = p_execution_id and status = 'executing' and claim_token = p_claim_token for update;
  if p_status = 'succeeded' and (not p_acknowledged or not p_externally_delivered or p_failure_category is not null)
    then raise exception 'Success requires provider acknowledgement'; end if;
  if p_status <> 'succeeded' and (p_externally_delivered or p_failure_category is null)
    then raise exception 'Failure result is inconsistent'; end if;
  update public.action_executions set status = p_status, acknowledged = p_acknowledged,
    externally_delivered = p_externally_delivered, provider_reference_id = p_provider_reference_id,
    result_summary = p_result_summary, failure_category = p_failure_category,
    failure_message = p_failure_message, completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = v_action.id;
  update public.work_items set status = case when p_status = 'succeeded' then 'handled' else 'needs_you' end,
    summary = coalesce(p_result_summary, summary),
    suggested_action = case when p_status = 'succeeded' then suggested_action else 'Review the action outcome before trying again.' end,
    resolved_at = case when p_status = 'succeeded' then clock_timestamp() else null end,
    updated_at = clock_timestamp()
  where id = v_action.work_item_id and status = 'waiting';
  return query select * from public.action_executions where id = v_action.id;
end;
$$;

revoke all on function public.create_action_approval(uuid, uuid, text, text, text, text, text, text, text, integer, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_action_approval(uuid, uuid, text, text, text, text, text, text, text, integer, uuid, jsonb)
  to service_role;
revoke all on function public.decide_action_execution(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.decide_action_execution(uuid, uuid, text, text) to service_role;
revoke all on function public.claim_action_execution(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_action_execution(uuid, uuid) to service_role;
revoke all on function public.complete_action_execution(uuid, uuid, text, boolean, boolean, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_action_execution(uuid, uuid, text, boolean, boolean, text, text, text, text)
  to service_role;

commit;
