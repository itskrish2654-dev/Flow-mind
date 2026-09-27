begin;

-- The existing work item assignee must be the approval decision owner.
create unique index work_items_approval_identity_idx
  on public.work_items(workspace_id, id, assignee_user_id);

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  work_item_id uuid not null,
  approver_user_id uuid not null,
  -- Retain UUID-only audit provenance if a different member later deletes their account.
  requested_by_user_id uuid,
  origin_type text not null,
  source_id text,
  request_key text not null,
  action_title text not null,
  action_summary text not null,
  approval_reason text not null,
  capability_id text not null,
  action_snapshot jsonb not null,
  status text not null default 'pending',
  decided_by_user_id uuid,
  decided_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint approval_requests_membership_fkey foreign key (workspace_id, approver_user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade,
  constraint approval_requests_work_item_fkey foreign key (workspace_id, work_item_id, approver_user_id)
    references public.work_items(workspace_id, id, assignee_user_id) on delete cascade,
  constraint approval_requests_origin_check check (origin_type in ('workflow', 'workflow_execution', 'connector_event', 'system', 'internal')),
  constraint approval_requests_source_check check (
    (source_id is null or char_length(source_id) between 1 and 200)
    and (origin_type not in ('workflow', 'workflow_execution', 'connector_event') or source_id is not null)
  ),
  constraint approval_requests_key_check check (char_length(request_key) between 1 and 160),
  constraint approval_requests_title_check check (char_length(trim(action_title)) between 1 and 180),
  constraint approval_requests_summary_check check (char_length(trim(action_summary)) between 1 and 2000),
  constraint approval_requests_reason_check check (char_length(trim(approval_reason)) between 1 and 1000),
  constraint approval_requests_capability_check check (capability_id ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  constraint approval_requests_snapshot_check check (
    coalesce(jsonb_typeof(action_snapshot) = 'object', false)
    and action_snapshot @> '{"version":1}'::jsonb
    and coalesce(action_snapshot ->> 'operationKey' = capability_id, false)
    and coalesce(jsonb_typeof(action_snapshot -> 'target') = 'object', false)
    and coalesce(jsonb_typeof(action_snapshot -> 'parameters') = 'array', false)
    and octet_length(action_snapshot::text) <= 8192
  ),
  constraint approval_requests_status_check check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint approval_requests_decision_check check (
    (status = 'pending' and decided_at is null and decided_by_user_id is null and rejection_reason is null)
    or (status in ('approved', 'cancelled') and decided_at is not null and decided_by_user_id is not null and rejection_reason is null)
    or (status = 'rejected' and decided_at is not null and decided_by_user_id is not null
        and (rejection_reason is null or char_length(rejection_reason) between 1 and 500))
  )
);

create index approval_requests_approver_status_created_idx
  on public.approval_requests(workspace_id, approver_user_id, status, created_at desc);
create index approval_requests_work_item_idx on public.approval_requests(work_item_id);
create index approval_requests_requested_by_idx on public.approval_requests(requested_by_user_id);
create index approval_requests_decided_by_idx on public.approval_requests(decided_by_user_id);
create unique index approval_requests_dedupe_idx
  on public.approval_requests(workspace_id, origin_type, coalesce(source_id, ''), request_key);
create unique index approval_requests_one_pending_per_item_idx
  on public.approval_requests(work_item_id) where status = 'pending';

create function public.guard_approval_request_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if old.status <> 'pending' or new.status not in ('approved', 'rejected', 'cancelled')
    or row(new.id, new.workspace_id, new.work_item_id, new.approver_user_id,
      new.requested_by_user_id, new.origin_type, new.source_id, new.request_key,
      new.action_title, new.action_summary, new.approval_reason, new.capability_id,
      new.action_snapshot, new.created_at)
       is distinct from
       row(old.id, old.workspace_id, old.work_item_id, old.approver_user_id,
      old.requested_by_user_id, old.origin_type, old.source_id, old.request_key,
      old.action_title, old.action_summary, old.approval_reason, old.capability_id,
      old.action_snapshot, old.created_at)
    or new.decided_by_user_id is null or new.decided_at is null
    or (new.status in ('approved', 'rejected') and new.decided_by_user_id <> old.approver_user_id)
    or (new.status = 'cancelled' and new.decided_by_user_id is distinct from old.requested_by_user_id)
    or new.updated_at is null or new.updated_at < old.updated_at
  then
    raise exception 'Approval proposal is immutable and only one terminal decision is allowed';
  end if;
  return new;
end;
$$;

create trigger approval_request_update_guard before update on public.approval_requests
  for each row execute function public.guard_approval_request_update();

create function public.guard_pending_approval_work_item()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.status is distinct from old.status
    and exists (select 1 from public.approval_requests as approval
      where approval.work_item_id = old.id and approval.status = 'pending')
  then
    raise exception 'Work item has a pending approval';
  end if;
  return new;
end;
$$;

create trigger work_item_pending_approval_guard before update of status on public.work_items
  for each row execute function public.guard_pending_approval_work_item();

alter table public.approval_requests enable row level security;
alter table public.approval_requests force row level security;
revoke all on table public.approval_requests from public, anon, authenticated;
grant select on table public.approval_requests to authenticated;
grant select, insert, update, delete on table public.approval_requests to service_role;

create policy approval_requests_approver_select on public.approval_requests
  for select to authenticated using (
    approver_user_id = (select auth.uid())
    and exists (select 1 from public.workspace_memberships as membership
      where membership.workspace_id = approval_requests.workspace_id
        and membership.user_id = (select auth.uid()) and membership.is_default)
  );

-- SECURITY INVOKER plus grants: only the backend service role can call these.
-- Row locks serialize retries and competing decisions with work-item updates.
create function public.create_approval_request(
  p_actor_user_id uuid, p_work_item_id uuid, p_approver_user_id uuid,
  p_origin_type text, p_source_id text, p_request_key text,
  p_action_title text, p_action_summary text, p_approval_reason text,
  p_capability_id text, p_action_snapshot jsonb
) returns setof public.approval_requests
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_item public.work_items%rowtype;
  v_existing public.approval_requests%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;
  if not exists (select 1 from public.workspace_memberships as membership
    where membership.workspace_id = v_workspace_id
      and membership.user_id = p_approver_user_id and membership.is_default)
  then raise exception 'Approval owner is not a workspace member'; end if;
  select * into strict v_item from public.work_items
  where id = p_work_item_id and workspace_id = v_workspace_id
    and assignee_user_id = p_approver_user_id for update;
  if v_item.source_type <> p_origin_type or v_item.source_id is distinct from p_source_id then
    raise exception 'Approval source does not match its work item';
  end if;

  select * into v_existing from public.approval_requests
  where workspace_id = v_workspace_id and origin_type = p_origin_type
    and coalesce(source_id, '') = coalesce(p_source_id, '')
    and request_key = p_request_key;
  if found then
    if v_existing.work_item_id <> p_work_item_id or v_existing.approver_user_id <> p_approver_user_id
      or v_existing.requested_by_user_id is distinct from p_actor_user_id
      or v_existing.action_title <> p_action_title or v_existing.action_summary <> p_action_summary
      or v_existing.approval_reason <> p_approval_reason or v_existing.capability_id <> p_capability_id
      or v_existing.action_snapshot <> p_action_snapshot
    then raise exception 'Approval idempotency key belongs to another proposal'; end if;
    return query select * from public.approval_requests where id = v_existing.id;
    return;
  end if;
  if v_item.status <> 'needs_you' then raise exception 'Work item is not awaiting approval'; end if;
  return query insert into public.approval_requests (
    workspace_id, work_item_id, approver_user_id, requested_by_user_id,
    origin_type, source_id, request_key, action_title, action_summary,
    approval_reason, capability_id, action_snapshot
  ) values (
    v_workspace_id, p_work_item_id, p_approver_user_id, p_actor_user_id,
    p_origin_type, p_source_id, p_request_key, p_action_title, p_action_summary,
    p_approval_reason, p_capability_id, p_action_snapshot
  ) returning *;
end;
$$;

create function public.decide_approval_request(
  p_approval_id uuid, p_actor_user_id uuid, p_decision text,
  p_rejection_reason text default null
) returns setof public.approval_requests
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_approval public.approval_requests%rowtype;
  v_item public.work_items%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_decision not in ('approved', 'rejected', 'cancelled') then raise exception 'Invalid approval decision'; end if;
  if p_decision <> 'rejected' and p_rejection_reason is not null then
    raise exception 'Rejection reason is only valid for rejection';
  end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;
  -- Lock in the same order as creation: Work Item, then approval. The first
  -- read is only to discover the linked item and is revalidated under lock.
  select * into strict v_approval from public.approval_requests
  where id = p_approval_id and workspace_id = v_workspace_id;
  select * into strict v_item from public.work_items
  where id = v_approval.work_item_id and workspace_id = v_workspace_id
    and assignee_user_id = v_approval.approver_user_id for update;
  select * into strict v_approval from public.approval_requests
  where id = p_approval_id and workspace_id = v_workspace_id for update;
  if v_approval.status <> 'pending' then raise exception 'Approval was already decided'; end if;
  if (p_decision = 'cancelled' and v_approval.requested_by_user_id is distinct from p_actor_user_id)
    or (p_decision <> 'cancelled' and v_approval.approver_user_id <> p_actor_user_id)
  then raise exception 'Not the approval decision owner'; end if;
  if v_approval.work_item_id <> v_item.id or v_approval.approver_user_id <> v_item.assignee_user_id then
    raise exception 'Approval work item changed';
  end if;
  if v_item.status <> 'needs_you' then raise exception 'Approval work item is no longer active'; end if;
  update public.approval_requests set status = p_decision,
    decided_by_user_id = p_actor_user_id, decided_at = clock_timestamp(),
    rejection_reason = case when p_decision = 'rejected' then p_rejection_reason else null end,
    updated_at = clock_timestamp()
  where id = p_approval_id;
  update public.work_items set status = 'done', resolved_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = v_item.id and status = 'needs_you';
  if not found then raise exception 'Approval work item could not be resolved'; end if;
  return query select * from public.approval_requests where id = p_approval_id;
end;
$$;

revoke all on function public.create_approval_request(uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_approval_request(uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb)
  to service_role;
revoke all on function public.decide_approval_request(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.decide_approval_request(uuid, uuid, text, text)
  to service_role;

commit;
