begin;

-- Human activity is separate from service-owned operational_events. It stores
-- identifiers and fixed event kinds only, never source text or provider data.
create table public.activity_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_user_id uuid not null,
  actor_user_id uuid,
  visibility text not null check (visibility in ('private', 'workspace')),
  event_type text not null check (event_type in (
    'work_item_created', 'work_item_needs_you', 'work_item_waiting', 'work_item_handled', 'work_item_done',
    'approval_requested', 'approval_approved', 'approval_rejected', 'approval_cancelled',
    'action_proposed', 'action_queued', 'action_executing', 'action_succeeded',
    'action_failed', 'action_ambiguous', 'action_rejected', 'action_cancelled',
    'workflow_succeeded', 'workflow_failed'
  )),
  source_type text not null check (source_type in ('work_item', 'approval', 'action', 'workflow_execution')),
  source_id uuid not null,
  work_item_id uuid,
  approval_request_id uuid,
  action_execution_id uuid,
  workflow_id uuid,
  event_key text not null check (char_length(event_key) between 1 and 240),
  occurred_at timestamptz not null default clock_timestamp(),
  constraint activity_events_identity_unique unique (workspace_id, event_key),
  constraint activity_events_owner_membership_fkey foreign key (workspace_id, owner_user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade
);

create index activity_events_workspace_recent_idx on public.activity_events(workspace_id, id desc);
create index activity_events_owner_recent_idx on public.activity_events(workspace_id, owner_user_id, id desc);
create index activity_events_action_idx on public.activity_events(action_execution_id, id);
create index activity_events_approval_idx on public.activity_events(approval_request_id, id);
create index activity_events_work_item_idx on public.activity_events(work_item_id, id);

alter table public.activity_events enable row level security;
alter table public.activity_events force row level security;
revoke all on public.activity_events from public, anon, authenticated;
grant select on public.activity_events to authenticated;
grant select, insert, delete on public.activity_events to service_role;

create policy activity_events_member_select on public.activity_events
  for select to authenticated using (
    ((visibility = 'workspace' and owner_user_id <> (select auth.uid()))
      or (visibility = 'private' and owner_user_id = (select auth.uid())))
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = activity_events.workspace_id
        and membership.user_id = (select auth.uid()) and membership.is_default
    )
  );

create function public.reject_activity_event_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'Activity history is immutable';
end;
$$;
create trigger activity_events_immutable before update on public.activity_events
  for each row execute function public.reject_activity_event_update();

-- Triggers share the source transaction. A failed domain mutation cannot leave
-- an Activity claim behind; a failed Activity write rolls the mutation back.
create function public.record_work_item_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'work_item_created';
  elsif new.status is distinct from old.status then
    v_event := 'work_item_' || new.status;
  else
    return new;
  end if;
  insert into public.activity_events (
    workspace_id, owner_user_id, actor_user_id, visibility, event_type,
    source_type, source_id, work_item_id, event_key, occurred_at
  ) values (
    new.workspace_id, new.assignee_user_id, new.assignee_user_id, 'private', v_event,
    'work_item', new.id, new.id,
    'work-item:' || new.id::text || ':' || v_event || ':' || new.updated_at::text,
    case when tg_op = 'INSERT' then new.created_at else new.updated_at end
  ) on conflict (workspace_id, event_key) do nothing;
  return new;
end;
$$;
create trigger work_item_activity_after_insert_update
  after insert or update on public.work_items for each row
  execute function public.record_work_item_activity();

create function public.record_approval_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'approval_requested';
  elsif new.status is distinct from old.status then
    v_event := 'approval_' || new.status;
  else
    return new;
  end if;
  insert into public.activity_events (
    workspace_id, owner_user_id, actor_user_id, visibility, event_type,
    source_type, source_id, work_item_id, approval_request_id, event_key, occurred_at
  ) values (
    new.workspace_id, new.approver_user_id,
    case when tg_op = 'INSERT' then new.requested_by_user_id else new.decided_by_user_id end,
    'private', v_event, 'approval', new.id, new.work_item_id, new.id,
    'approval:' || new.id::text || ':' || v_event,
    case when tg_op = 'INSERT' then new.created_at else new.decided_at end
  ) on conflict (workspace_id, event_key) do nothing;
  return new;
end;
$$;
create trigger approval_activity_after_insert_update
  after insert or update on public.approval_requests for each row
  execute function public.record_approval_activity();

create function public.record_action_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'action_proposed';
  elsif new.status is distinct from old.status then
    v_event := 'action_' || new.status;
  else
    return new;
  end if;
  insert into public.activity_events (
    workspace_id, owner_user_id, actor_user_id, visibility, event_type,
    source_type, source_id, work_item_id, approval_request_id,
    action_execution_id, event_key, occurred_at
  ) values (
    new.workspace_id, new.requester_user_id, new.requester_user_id, 'private', v_event,
    'action', new.id, new.work_item_id, new.approval_request_id, new.id,
    'action:' || new.id::text || ':' || v_event || ':' || new.attempt_count::text,
    case when new.status in ('succeeded', 'failed', 'ambiguous', 'rejected', 'cancelled')
      then new.completed_at else new.updated_at end
  ) on conflict (workspace_id, event_key) do nothing;
  if v_event in ('action_succeeded', 'action_failed', 'action_ambiguous') then
    -- Only a deliberately generic outcome is company-visible. No target,
    -- recipient, message, provider reference, or Ask content is copied.
    insert into public.activity_events (
      workspace_id, owner_user_id, actor_user_id, visibility, event_type,
      source_type, source_id, action_execution_id, event_key, occurred_at
    ) values (
      new.workspace_id, new.requester_user_id, new.requester_user_id, 'workspace', v_event,
      'action', new.id, new.id,
      'shared-action:' || new.id::text || ':' || v_event || ':' || new.attempt_count::text,
      new.completed_at
    ) on conflict (workspace_id, event_key) do nothing;
  end if;
  return new;
end;
$$;
create trigger action_activity_after_insert_update
  after insert or update on public.action_executions for each row
  execute function public.record_action_activity();

create function public.record_workflow_execution_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_workspace_id uuid;
declare v_event text;
begin
  if new.status not in ('succeeded', 'failed', 'partially_failed')
    or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return new;
  end if;
  select workflow.workspace_id into v_workspace_id from public.workflows as workflow
    where workflow.id = new.workflow_id and workflow.user_id = new.user_id;
  if v_workspace_id is null then return new; end if;
  v_event := case when new.status = 'succeeded' then 'workflow_succeeded' else 'workflow_failed' end;
  insert into public.activity_events (
    workspace_id, owner_user_id, actor_user_id, visibility, event_type,
    source_type, source_id, workflow_id, event_key, occurred_at
  ) values (
    v_workspace_id, new.user_id, new.user_id, 'private', v_event,
    'workflow_execution', new.id, new.workflow_id,
    'workflow-execution:' || new.id::text || ':' || new.status || ':' || new.attempt_count::text,
    coalesce(new.completed_at, clock_timestamp())
  ) on conflict (workspace_id, event_key) do nothing;
  return new;
end;
$$;
create trigger workflow_execution_activity_after_insert_update
  after insert or update on public.workflow_executions for each row
  execute function public.record_workflow_execution_activity();

revoke all on function public.reject_activity_event_update() from public, anon, authenticated;
revoke all on function public.record_work_item_activity() from public, anon, authenticated;
revoke all on function public.record_approval_activity() from public, anon, authenticated;
revoke all on function public.record_action_activity() from public, anon, authenticated;
revoke all on function public.record_workflow_execution_activity() from public, anon, authenticated;

commit;
