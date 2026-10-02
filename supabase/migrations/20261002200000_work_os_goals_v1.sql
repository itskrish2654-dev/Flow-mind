begin;

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by_user_id uuid references auth.users(id) on delete set null,
  owner_user_id uuid references auth.users(id) on delete set null,
  last_actor_user_id uuid references auth.users(id) on delete set null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  title text not null check (char_length(trim(title)) between 8 and 180),
  description text check (description is null or char_length(description) <= 2000),
  success_criteria text check (success_criteria is null or char_length(success_criteria) between 10 and 1000),
  target_date date,
  status text not null default 'draft' check (status in ('draft', 'awaiting_approval', 'active', 'completed', 'cancelled')),
  current_plan_id uuid,
  approved_plan_id uuid,
  activated_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  unique (workspace_id, created_by_user_id, request_key),
  check (status not in ('active', 'completed') or (approved_plan_id is not null and activated_at is not null)),
  check (status <> 'completed' or completed_at is not null),
  check (status <> 'cancelled' or cancelled_at is not null)
);
create index goals_workspace_recent_idx on public.goals(workspace_id, created_at desc);
create index goals_owner_idx on public.goals(owner_user_id);
create index goals_created_by_idx on public.goals(created_by_user_id);
create index goals_last_actor_idx on public.goals(last_actor_user_id);

create table public.goal_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  goal_id uuid not null,
  revision integer not null check (revision between 1 and 100),
  status text not null default 'proposed' check (status in ('proposed', 'superseded', 'approved')),
  origin text not null check (origin in ('manager', 'ai_assisted')),
  proposed_by_user_id uuid references auth.users(id) on delete set null,
  approved_by_user_id uuid references auth.users(id) on delete set null,
  source_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_references) = 'array' and pg_column_size(source_references) <= 8192),
  created_at timestamptz not null default clock_timestamp(),
  approved_at timestamptz,
  foreign key (workspace_id, goal_id) references public.goals(workspace_id, id) on delete cascade,
  unique (goal_id, revision),
  unique (workspace_id, goal_id, id),
  check ((status = 'approved') = (approved_at is not null))
);
create unique index goal_plans_one_proposed_idx on public.goal_plans(goal_id) where status = 'proposed';
create unique index goal_plans_one_approved_idx on public.goal_plans(goal_id) where status = 'approved';
create index goal_plans_workspace_goal_idx on public.goal_plans(workspace_id, goal_id, revision desc);
create index goal_plans_proposer_idx on public.goal_plans(proposed_by_user_id);
create index goal_plans_approver_idx on public.goal_plans(approved_by_user_id);

alter table public.goals add constraint goals_current_plan_fkey foreign key (workspace_id, id, current_plan_id)
  references public.goal_plans(workspace_id, goal_id, id) on delete set null (current_plan_id);
alter table public.goals add constraint goals_approved_plan_fkey foreign key (workspace_id, id, approved_plan_id)
  references public.goal_plans(workspace_id, goal_id, id) on delete set null (approved_plan_id);

create table public.goal_plan_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  goal_id uuid not null,
  plan_id uuid not null,
  position integer not null check (position between 1 and 12),
  title text not null check (char_length(trim(title)) between 1 and 180),
  description text check (description is null or char_length(description) <= 1000),
  rationale text check (rationale is null or char_length(rationale) <= 500),
  suggested_owner_role text check (suggested_owner_role is null or char_length(suggested_owner_role) <= 80),
  assignee_user_id uuid references auth.users(id) on delete set null,
  due_at timestamptz,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, goal_id, plan_id)
    references public.goal_plans(workspace_id, goal_id, id) on delete cascade,
  unique (plan_id, position),
  unique (workspace_id, goal_id, id)
);
create index goal_plan_items_assignee_idx on public.goal_plan_items(assignee_user_id);
create index goal_plan_items_plan_idx on public.goal_plan_items(plan_id, position);

alter table public.work_items add column goal_id uuid;
alter table public.work_items add column goal_plan_item_id uuid;
alter table public.work_items add constraint work_items_goal_link_complete check (
  (goal_id is null and goal_plan_item_id is null) or (goal_id is not null and goal_plan_item_id is not null)
);
alter table public.work_items add constraint work_items_goal_fk foreign key (workspace_id, goal_id)
  references public.goals(workspace_id, id) on delete set null (goal_id);
alter table public.work_items add constraint work_items_goal_plan_item_fk
  foreign key (workspace_id, goal_id, goal_plan_item_id)
  references public.goal_plan_items(workspace_id, goal_id, id)
  on delete set null (goal_id, goal_plan_item_id);
create unique index work_items_goal_plan_item_unique on public.work_items(goal_plan_item_id)
  where goal_plan_item_id is not null;
create index work_items_goal_status_idx on public.work_items(workspace_id, goal_id, status);

alter table public.goals enable row level security;
alter table public.goals force row level security;
alter table public.goal_plans enable row level security;
alter table public.goal_plans force row level security;
alter table public.goal_plan_items enable row level security;
alter table public.goal_plan_items force row level security;
revoke all on public.goals, public.goal_plans, public.goal_plan_items from public, anon, authenticated;
grant select on public.goals, public.goal_plans, public.goal_plan_items to authenticated;
grant select, insert, update, delete on public.goals, public.goal_plans, public.goal_plan_items to service_role;
create policy goals_member_select on public.goals for select to authenticated using (
  exists (select 1 from public.workspace_memberships m where m.workspace_id = goals.workspace_id
    and m.user_id = (select auth.uid()) and m.is_default)
);
create policy goal_plans_member_select on public.goal_plans for select to authenticated using (
  exists (select 1 from public.workspace_memberships m where m.workspace_id = goal_plans.workspace_id
    and m.user_id = (select auth.uid()) and m.is_default)
);
create policy goal_plan_items_member_select on public.goal_plan_items for select to authenticated using (
  exists (select 1 from public.workspace_memberships m where m.workspace_id = goal_plan_items.workspace_id
    and m.user_id = (select auth.uid()) and m.is_default)
);

create function public.guard_goal_plan_immutability()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if row(old.id, old.workspace_id, old.goal_id, old.revision, old.origin,
      old.proposed_by_user_id, old.source_references, old.created_at)
      is distinct from row(new.id, new.workspace_id, new.goal_id, new.revision, new.origin,
      new.proposed_by_user_id, new.source_references, new.created_at)
      or old.status <> 'proposed' or new.status not in ('superseded', 'approved') then
      raise exception 'Goal plan revisions are immutable';
    end if;
    return new;
  end if;
  if exists (select 1 from public.goals g where g.id = old.goal_id and g.status in ('active', 'completed')) then
    raise exception 'Approved goal plans cannot be removed';
  end if;
  return old;
end;
$$;
create trigger goal_plans_immutable before update or delete on public.goal_plans
  for each row execute function public.guard_goal_plan_immutability();

create function public.guard_goal_plan_item_immutability()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then raise exception 'Goal plan items are immutable'; end if;
  if exists (select 1 from public.goal_plans p where p.id = old.plan_id and p.status = 'approved') then
    raise exception 'Approved goal plan items cannot be removed';
  end if;
  return old;
end;
$$;
create trigger goal_plan_items_immutable before update or delete on public.goal_plan_items
  for each row execute function public.guard_goal_plan_item_immutability();

create function public.save_goal_plan(
  p_actor_user_id uuid, p_goal_id uuid, p_expected_revision integer,
  p_origin text, p_items jsonb, p_source_chunk_ids uuid[] default '{}'
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_goal public.goals%rowtype;
declare v_current public.goal_plans%rowtype;
declare v_plan_id uuid := gen_random_uuid();
declare v_item jsonb;
declare v_position integer := 0;
declare v_assignee uuid;
declare v_sources jsonb := '[]'::jsonb;
declare v_next_revision integer;
begin
  select * into v_goal from public.goals where id = p_goal_id for update;
  if v_goal.id is null or p_actor_user_id is null or not exists (
    select 1 from public.workspace_memberships m where m.workspace_id = v_goal.workspace_id
      and m.user_id = p_actor_user_id and m.is_default and m.role in ('owner', 'admin')
  ) then raise exception 'Goal plan is unavailable'; end if;
  if v_goal.status not in ('draft', 'awaiting_approval') or p_origin not in ('manager', 'ai_assisted')
    or p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 100
    or p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 12
    or coalesce(array_length(p_source_chunk_ids, 1), 0) > 8 then
    raise exception 'Goal plan is not ready for review';
  end if;
  if v_goal.current_plan_id is not null then
    select * into v_current from public.goal_plans where id = v_goal.current_plan_id for update;
    if v_current.id is null or v_current.goal_id <> v_goal.id or v_current.status <> 'proposed'
      or v_current.revision <> p_expected_revision then raise exception 'Goal plan changed; refresh before saving'; end if;
    update public.goal_plans set status = 'superseded' where id = v_current.id;
  elsif p_expected_revision <> 0 then
    raise exception 'Goal plan changed; refresh before saving';
  end if;
  select coalesce(max(revision), 0) + 1 into v_next_revision
    from public.goal_plans where goal_id = v_goal.id;
  if v_next_revision > 100 then raise exception 'Goal plan revision limit reached'; end if;
  if coalesce(array_length(p_source_chunk_ids, 1), 0) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('documentId', d.id, 'chunkId', c.id,
      'title', d.title, 'pageNumber', c.page_number, 'section', c.chunk_index + 1)
      order by source.ordinality), '[]'::jsonb) into v_sources
    from unnest(p_source_chunk_ids) with ordinality as source(chunk_id, ordinality)
    join public.knowledge_chunks c on c.id = source.chunk_id and c.workspace_id = v_goal.workspace_id
    join public.knowledge_documents d on d.id = c.document_id and d.workspace_id = v_goal.workspace_id
      and d.status = 'ready';
    if jsonb_array_length(v_sources) <> array_length(p_source_chunk_ids, 1) then
      raise exception 'A company knowledge source is no longer available';
    end if;
  end if;
  insert into public.goal_plans(id, workspace_id, goal_id, revision, origin,
    proposed_by_user_id, source_references)
    values (v_plan_id, v_goal.workspace_id, v_goal.id, v_next_revision,
      p_origin, p_actor_user_id, v_sources);
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_position := v_position + 1;
    if jsonb_typeof(v_item) <> 'object' or nullif(trim(v_item->>'title'), '') is null
      or char_length(v_item->>'title') > 180
      or char_length(coalesce(v_item->>'description', '')) > 1000
      or char_length(coalesce(v_item->>'rationale', '')) > 500
      or char_length(coalesce(v_item->>'suggestedOwnerRole', '')) > 80
      or coalesce(v_item->>'priority', 'normal') not in ('low', 'normal', 'high') then
      raise exception 'Goal plan item is invalid';
    end if;
    v_assignee := nullif(v_item->>'assigneeUserId', '')::uuid;
    if v_assignee is not null and not exists (
      select 1 from public.workspace_memberships m where m.workspace_id = v_goal.workspace_id
        and m.user_id = v_assignee and m.is_default
    ) then raise exception 'Goal plan assignee is not in this workspace'; end if;
    insert into public.goal_plan_items(workspace_id, goal_id, plan_id, position,
      title, description, rationale, suggested_owner_role, assignee_user_id, due_at, priority)
    values (v_goal.workspace_id, v_goal.id, v_plan_id, v_position,
      trim(v_item->>'title'), nullif(trim(v_item->>'description'), ''),
      nullif(trim(v_item->>'rationale'), ''), nullif(trim(v_item->>'suggestedOwnerRole'), ''),
      v_assignee, nullif(v_item->>'dueAt', '')::timestamptz,
      coalesce(v_item->>'priority', 'normal'));
  end loop;
  update public.goals set current_plan_id = v_plan_id, status = 'awaiting_approval',
    last_actor_user_id = p_actor_user_id, updated_at = clock_timestamp() where id = v_goal.id;
  return v_plan_id;
end;
$$;
revoke all on function public.save_goal_plan(uuid, uuid, integer, text, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.save_goal_plan(uuid, uuid, integer, text, jsonb, uuid[]) to service_role;

create function public.update_goal_draft(
  p_actor_user_id uuid, p_goal_id uuid, p_expected_updated_at timestamptz,
  p_owner_user_id uuid, p_title text, p_description text,
  p_success_criteria text, p_target_date date
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_goal public.goals%rowtype;
begin
  select * into v_goal from public.goals where id = p_goal_id for update;
  if v_goal.id is null or p_actor_user_id is null or not exists (
    select 1 from public.workspace_memberships m where m.workspace_id = v_goal.workspace_id
      and m.user_id = p_actor_user_id and m.is_default and m.role in ('owner', 'admin')
  ) then raise exception 'Goal is unavailable'; end if;
  if v_goal.status not in ('draft', 'awaiting_approval') or v_goal.updated_at <> p_expected_updated_at
    or not exists (select 1 from public.workspace_memberships m
      where m.workspace_id = v_goal.workspace_id and m.user_id = p_owner_user_id and m.is_default)
    or char_length(trim(p_title)) not between 8 and 180
    or (p_success_criteria is not null and char_length(p_success_criteria) not between 10 and 1000)
  then raise exception 'Goal changed; refresh before editing'; end if;
  if v_goal.current_plan_id is not null then
    update public.goal_plans set status = 'superseded'
      where id = v_goal.current_plan_id and status = 'proposed';
  end if;
  update public.goals set owner_user_id = p_owner_user_id, title = trim(p_title),
    description = nullif(trim(p_description), ''),
    success_criteria = nullif(trim(p_success_criteria), ''),
    target_date = p_target_date, status = 'draft', current_plan_id = null,
    last_actor_user_id = p_actor_user_id,
    updated_at = clock_timestamp() where id = v_goal.id;
  return v_goal.id;
end;
$$;
revoke all on function public.update_goal_draft(uuid, uuid, timestamptz, uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function public.update_goal_draft(uuid, uuid, timestamptz, uuid, text, text, text, date)
  to service_role;

create function public.activate_goal_plan(
  p_actor_user_id uuid, p_goal_id uuid, p_plan_id uuid, p_expected_revision integer
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_goal public.goals%rowtype;
declare v_plan public.goal_plans%rowtype;
declare v_total integer;
declare v_valid integer;
begin
  select * into v_goal from public.goals where id = p_goal_id for update;
  if v_goal.id is null or p_actor_user_id is null or not exists (
    select 1 from public.workspace_memberships m where m.workspace_id = v_goal.workspace_id
      and m.user_id = p_actor_user_id and m.is_default and m.role in ('owner', 'admin')
  ) then raise exception 'Goal plan is unavailable'; end if;
  if v_goal.status = 'active' and v_goal.approved_plan_id = p_plan_id then return v_goal.id; end if;
  if v_goal.status <> 'awaiting_approval' or v_goal.current_plan_id <> p_plan_id
    or nullif(trim(v_goal.success_criteria), '') is null or p_expected_revision is null then
    raise exception 'Goal plan changed; refresh before approval';
  end if;
  select * into v_plan from public.goal_plans where id = p_plan_id for update;
  if v_plan.id is null or v_plan.workspace_id <> v_goal.workspace_id or v_plan.goal_id <> v_goal.id
    or v_plan.status <> 'proposed' or v_plan.revision <> p_expected_revision then
    raise exception 'Goal plan changed; refresh before approval';
  end if;
  select count(*), count(*) filter (where i.assignee_user_id is not null and m.user_id is not null)
    into v_total, v_valid
    from public.goal_plan_items i left join public.workspace_memberships m
      on m.workspace_id = i.workspace_id and m.user_id = i.assignee_user_id and m.is_default
    where i.plan_id = p_plan_id and i.workspace_id = v_goal.workspace_id;
  if v_total not between 1 and 12 or v_total <> v_valid then
    raise exception 'Assign every plan item to a current workspace member';
  end if;
  update public.goal_plans set status = 'approved', approved_by_user_id = p_actor_user_id,
    approved_at = clock_timestamp() where id = p_plan_id;
  insert into public.work_items(workspace_id, assignee_user_id, title, summary,
    why_it_matters, status, priority, due_at, source_type, source_id,
    source_label, dedupe_key, goal_id, goal_plan_item_id)
  select i.workspace_id, i.assignee_user_id, i.title, i.description, i.rationale,
    'needs_you', i.priority, i.due_at, 'internal', i.id::text,
    'Goal: ' || left(v_goal.title, 114), 'goal-plan-item:' || i.id::text,
    v_goal.id, i.id
  from public.goal_plan_items i where i.plan_id = p_plan_id order by i.position;
  update public.goals set status = 'active', approved_plan_id = p_plan_id,
    activated_at = clock_timestamp(), last_actor_user_id = p_actor_user_id,
    updated_at = clock_timestamp()
    where id = v_goal.id;
  return v_goal.id;
end;
$$;
revoke all on function public.activate_goal_plan(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.activate_goal_plan(uuid, uuid, uuid, integer) to service_role;

create function public.finish_goal(
  p_actor_user_id uuid, p_goal_id uuid, p_action text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_goal public.goals%rowtype;
declare v_total integer;
declare v_done integer;
begin
  select * into v_goal from public.goals where id = p_goal_id for update;
  if v_goal.id is null or p_actor_user_id is null or not exists (
    select 1 from public.workspace_memberships m where m.workspace_id = v_goal.workspace_id
      and m.user_id = p_actor_user_id and m.is_default and m.role in ('owner', 'admin')
  ) then raise exception 'Goal is unavailable'; end if;
  if p_action = 'cancel' and v_goal.status in ('draft', 'awaiting_approval') then
    update public.goals set status = 'cancelled', cancelled_at = clock_timestamp(),
      last_actor_user_id = p_actor_user_id, updated_at = clock_timestamp() where id = v_goal.id;
    return v_goal.id;
  end if;
  if p_action = 'complete' and v_goal.status = 'active' then
    select count(*), count(*) filter (where w.status = 'done') into v_total, v_done
      from public.goal_plan_items i left join public.work_items w
        on w.goal_plan_item_id = i.id and w.goal_id = v_goal.id and w.workspace_id = v_goal.workspace_id
      where i.plan_id = v_goal.approved_plan_id;
    if v_total > 0 and v_total = v_done then
      update public.goals set status = 'completed', completed_at = clock_timestamp(),
        last_actor_user_id = p_actor_user_id, updated_at = clock_timestamp() where id = v_goal.id;
      return v_goal.id;
    end if;
    raise exception 'Goal work is not all completed';
  end if;
  raise exception 'Goal transition is unavailable';
end;
$$;
revoke all on function public.finish_goal(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.finish_goal(uuid, uuid, text) to service_role;

alter table public.activity_events add column goal_id uuid references public.goals(id) on delete set null;
alter table public.activity_events drop constraint activity_events_event_type_check;
alter table public.activity_events add constraint activity_events_event_type_check check (event_type in (
  'work_item_created', 'work_item_needs_you', 'work_item_waiting', 'work_item_handled', 'work_item_done',
  'approval_requested', 'approval_approved', 'approval_rejected', 'approval_cancelled',
  'action_proposed', 'action_queued', 'action_executing', 'action_succeeded',
  'action_failed', 'action_ambiguous', 'action_rejected', 'action_cancelled',
  'workflow_succeeded', 'workflow_failed',
  'goal_created', 'goal_plan_proposed', 'goal_plan_approved', 'goal_activated', 'goal_completed', 'goal_cancelled'
));
alter table public.activity_events drop constraint activity_events_source_type_check;
alter table public.activity_events add constraint activity_events_source_type_check check (
  source_type in ('work_item', 'approval', 'action', 'workflow_execution', 'goal')
);
create index activity_events_goal_idx on public.activity_events(goal_id, id);

create function public.record_goal_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_type text;
declare v_owner uuid;
declare v_actor uuid;
begin
  if tg_table_name = 'goal_plans' then
    if tg_op = 'INSERT' then v_type := 'goal_plan_proposed';
    elsif new.status = 'approved' and old.status = 'proposed' then v_type := 'goal_plan_approved';
    else return new; end if;
    v_actor := case when v_type = 'goal_plan_approved' then new.approved_by_user_id else new.proposed_by_user_id end;
    select g.owner_user_id into v_owner from public.goals g where g.id = new.goal_id;
  else
    if tg_op = 'INSERT' then v_type := 'goal_created';
    elsif new.status is distinct from old.status and new.status in ('active', 'completed', 'cancelled')
      then v_type := 'goal_' || new.status;
    else return new; end if;
    v_owner := new.owner_user_id;
    v_actor := coalesce(new.last_actor_user_id, new.created_by_user_id);
  end if;
  if not exists (select 1 from public.workspace_memberships m
    where m.workspace_id = new.workspace_id and m.user_id = v_owner) then
    v_owner := v_actor;
  end if;
  if v_owner is null then return new; end if;
  insert into public.activity_events(workspace_id, owner_user_id, actor_user_id,
    visibility, event_type, source_type, source_id, goal_id, event_key)
  values (new.workspace_id, v_owner, v_actor, 'private', v_type, 'goal',
    case when tg_table_name = 'goal_plans' then new.id else new.id end,
    case when tg_table_name = 'goal_plans' then new.goal_id else new.id end,
    'goal:' || case when tg_table_name = 'goal_plans' then new.id::text else new.id::text end || ':' || v_type)
  on conflict (workspace_id, event_key) do nothing;
  insert into public.activity_events(workspace_id, owner_user_id, actor_user_id,
    visibility, event_type, source_type, source_id, goal_id, event_key)
  values (new.workspace_id, v_owner, v_actor, 'workspace', v_type, 'goal',
    new.id, case when tg_table_name = 'goal_plans' then new.goal_id else new.id end,
    'shared-goal:' || new.id::text || ':' || v_type)
  on conflict (workspace_id, event_key) do nothing;
  return new;
end;
$$;
create trigger goals_activity_after_insert_update after insert or update on public.goals
  for each row execute function public.record_goal_activity();
create trigger goal_plans_activity_after_insert_update after insert or update on public.goal_plans
  for each row execute function public.record_goal_activity();
revoke all on function public.guard_goal_plan_immutability() from public, anon, authenticated;
revoke all on function public.guard_goal_plan_item_immutability() from public, anon, authenticated;
revoke all on function public.record_goal_activity() from public, anon, authenticated;

commit;
