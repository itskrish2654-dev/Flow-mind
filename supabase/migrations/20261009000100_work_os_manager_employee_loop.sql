begin;

-- Extend the existing Work Item lifecycle; do not create a second task store.
alter table public.work_items drop constraint work_items_status_check;
alter table public.work_items add constraint work_items_status_check check (
  status in ('needs_you', 'in_progress', 'waiting', 'blocked', 'handled', 'done')
);
alter table public.work_items drop constraint work_items_resolution_check;
alter table public.work_items add constraint work_items_resolution_check check (
  (status in ('done', 'handled') and resolved_at is not null)
  or (status in ('needs_you', 'in_progress', 'waiting', 'blocked') and resolved_at is null)
);
alter table public.work_items add column status_reason text;
alter table public.work_items add constraint work_items_status_reason_length_check check (
  status_reason is null or char_length(trim(status_reason)) between 1 and 500
);
alter table public.work_items add column status_actor_user_id uuid references auth.users(id) on delete set null;
alter table public.work_items add constraint work_items_status_reason_check check (
  status_reason is null or status in ('waiting', 'blocked')
);
create index work_items_status_actor_idx on public.work_items(status_actor_user_id)
  where status_actor_user_id is not null;
create index work_items_manager_board_idx on public.work_items(workspace_id, goal_id, assignee_user_id, due_at)
  where goal_id is not null;

-- Approved plan snapshots stay immutable. A manager may adjust the live assignment
-- or due date, but only for work created from an approved plan in their workspace.
create function public.revise_goal_work_assignment(
  p_actor_user_id uuid, p_goal_id uuid, p_work_item_id uuid, p_expected_updated_at timestamptz,
  p_assignee_user_id uuid, p_due_at timestamptz
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_item public.work_items%rowtype;
begin
  select * into v_item from public.work_items where id = p_work_item_id for update;
  if v_item.id is null or v_item.goal_id is distinct from p_goal_id
    or v_item.goal_plan_item_id is null
    or v_item.status in ('done', 'handled') or v_item.updated_at is distinct from p_expected_updated_at
    or p_assignee_user_id is null or not exists (
      select 1 from public.workspace_memberships m where m.workspace_id = v_item.workspace_id
        and m.user_id = p_actor_user_id and m.is_default and m.role in ('owner', 'admin')
    ) or not exists (
      select 1 from public.workspace_memberships m where m.workspace_id = v_item.workspace_id
        and m.user_id = p_assignee_user_id and m.is_default
    ) or not exists (
      select 1 from public.goals g where g.id = v_item.goal_id
        and g.workspace_id = v_item.workspace_id and g.status = 'active'
        and g.approved_plan_id = (
          select i.plan_id from public.goal_plan_items i where i.id = v_item.goal_plan_item_id
        )
    ) then raise exception 'Goal work assignment is unavailable or changed'; end if;
  if v_item.assignee_user_id = p_assignee_user_id and v_item.due_at is not distinct from p_due_at then
    return v_item.id;
  end if;
  update public.work_items set assignee_user_id = p_assignee_user_id, due_at = p_due_at,
    status_actor_user_id = p_actor_user_id, updated_at = clock_timestamp()
    where id = v_item.id;
  return v_item.id;
end;
$$;
revoke all on function public.revise_goal_work_assignment(uuid, uuid, uuid, timestamptz, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.revise_goal_work_assignment(uuid, uuid, uuid, timestamptz, uuid, timestamptz)
  to service_role;

alter table public.activity_events drop constraint activity_events_event_type_check;
alter table public.activity_events add constraint activity_events_event_type_check check (event_type in (
  'work_item_created', 'work_item_needs_you', 'work_item_in_progress', 'work_item_waiting',
  'work_item_blocked', 'work_item_handled', 'work_item_done', 'work_item_reassigned',
  'work_item_due_changed',
  'approval_requested', 'approval_approved', 'approval_rejected', 'approval_cancelled',
  'action_proposed', 'action_queued', 'action_executing', 'action_succeeded',
  'action_failed', 'action_ambiguous', 'action_rejected', 'action_cancelled',
  'workflow_succeeded', 'workflow_failed',
  'goal_created', 'goal_plan_proposed', 'goal_plan_approved', 'goal_activated',
  'goal_completed', 'goal_cancelled'
));

create or replace function public.record_work_item_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_events text[] := '{}';
declare v_event text;
declare v_actor uuid;
begin
  if tg_op = 'INSERT' then
    v_events := array['work_item_created'];
  else
    if new.assignee_user_id is distinct from old.assignee_user_id then
      v_events := array_append(v_events, 'work_item_reassigned');
    end if;
    if new.due_at is distinct from old.due_at then
      v_events := array_append(v_events, 'work_item_due_changed');
    end if;
    if new.status is distinct from old.status then
      v_events := array_append(v_events, 'work_item_' || new.status);
    end if;
  end if;
  v_actor := coalesce(new.status_actor_user_id, new.assignee_user_id);
  foreach v_event in array v_events loop
    -- Existing private activity remains visible to the assigned employee only.
    insert into public.activity_events(workspace_id, owner_user_id, actor_user_id,
      visibility, event_type, source_type, source_id, work_item_id, goal_id, event_key, occurred_at)
    values (new.workspace_id, new.assignee_user_id, v_actor, 'private', v_event,
      'work_item', new.id, new.id, new.goal_id,
      'work-item:' || new.id::text || ':' || v_event || ':' || new.updated_at::text,
      case when tg_op = 'INSERT' then new.created_at else new.updated_at end)
    on conflict (workspace_id, event_key) do nothing;
    if new.goal_id is not null then
      -- Company work state is shared; no reason, private Ask text or connector
      -- payload is copied into this generic event. The assignee owns the
      -- event identity so a manager assigned to the item sees only their
      -- private copy, while other managers see the generic shared copy.
      insert into public.activity_events(workspace_id, owner_user_id, actor_user_id,
        visibility, event_type, source_type, source_id, work_item_id, goal_id, event_key, occurred_at)
      values (new.workspace_id, new.assignee_user_id, v_actor, 'workspace', v_event,
        'work_item', new.id, new.id, new.goal_id,
        'shared-work-item:' || new.id::text || ':' || v_event || ':' || new.updated_at::text,
        case when tg_op = 'INSERT' then new.created_at else new.updated_at end)
      on conflict (workspace_id, event_key) do nothing;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.record_work_item_activity() from public, anon, authenticated;

-- The assigned employee sees their private trail; workspace managers see
-- generic company-work events, even when they own the goal. Other members do
-- not gain a team activity feed or access to another employee's private trail.
drop policy activity_events_member_select on public.activity_events;
create policy activity_events_member_select on public.activity_events
  for select to authenticated using (
    ((visibility = 'private' and owner_user_id = (select auth.uid()))
      or (visibility = 'workspace' and source_type <> 'work_item'
        and owner_user_id <> (select auth.uid()))
      or (visibility = 'workspace' and source_type = 'work_item'
        and owner_user_id <> (select auth.uid()) and exists (
        select 1 from public.workspace_memberships manager
        where manager.workspace_id = activity_events.workspace_id
          and manager.user_id = (select auth.uid()) and manager.is_default
          and manager.role in ('owner', 'admin')
      )))
    and exists (
      select 1 from public.workspace_memberships membership
      where membership.workspace_id = activity_events.workspace_id
        and membership.user_id = (select auth.uid()) and membership.is_default
    )
  );

commit;
