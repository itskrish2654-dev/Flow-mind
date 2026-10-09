begin;

-- Private AI working notes and reviewable deliverables have separate read boundaries.
create table public.work_item_ai_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  request_key uuid not null,
  mode text not null check (mode in ('GENERAL','RESEARCH','WRITING','DATA','CODING','MARKETING')),
  instruction text not null check (char_length(instruction) between 1 and 2000),
  response_title text check (response_title is null or char_length(response_title) between 1 and 180),
  response_content text check (response_content is null or char_length(response_content) between 1 and 16000),
  source_references jsonb not null default '[]'::jsonb check (jsonb_typeof(source_references) = 'array' and pg_column_size(source_references) <= 8192),
  status text not null default 'processing' check (status in ('processing','completed','failed')),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique (owner_user_id, work_item_id, request_key),
  check ((status = 'processing') = (finished_at is null)),
  check (status <> 'completed' or (response_title is not null and response_content is not null))
);
create index work_item_ai_turns_owner_recent_idx on public.work_item_ai_turns(workspace_id, owner_user_id, work_item_id, created_at desc);
create index work_item_ai_turns_item_idx on public.work_item_ai_turns(work_item_id);

create table public.work_item_deliverables (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  goal_id uuid references public.goals(id) on delete set null,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  ai_turn_id uuid references public.work_item_ai_turns(id) on delete set null,
  based_on_id uuid references public.work_item_deliverables(id) on delete set null,
  request_key uuid not null,
  title text not null check (char_length(trim(title)) between 1 and 180),
  content text not null check (char_length(trim(content)) between 1 and 16000),
  source_references jsonb not null default '[]'::jsonb check (jsonb_typeof(source_references) = 'array' and pg_column_size(source_references) <= 8192),
  ai_assisted boolean not null default false,
  status text not null default 'draft' check (status in ('draft','final')),
  created_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  unique (owner_user_id, work_item_id, request_key),
  check ((status = 'final') = (finalized_at is not null))
);
create index work_item_deliverables_item_recent_idx on public.work_item_deliverables(workspace_id, work_item_id, created_at desc);
create index work_item_deliverables_work_item_fk_idx on public.work_item_deliverables(work_item_id);
create index work_item_deliverables_goal_fk_idx on public.work_item_deliverables(goal_id) where goal_id is not null;
create index work_item_deliverables_manager_final_idx on public.work_item_deliverables(workspace_id, goal_id, work_item_id, finalized_at desc) where status = 'final';
create index work_item_deliverables_owner_idx on public.work_item_deliverables(owner_user_id);
create index work_item_deliverables_turn_idx on public.work_item_deliverables(ai_turn_id) where ai_turn_id is not null;
create index work_item_deliverables_base_idx on public.work_item_deliverables(based_on_id) where based_on_id is not null;

create function public.validate_work_item_ai_ownership() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_item public.work_items%rowtype;
begin
  select * into v_item from public.work_items where id = new.work_item_id;
  if v_item.id is null or v_item.workspace_id <> new.workspace_id
    or v_item.assignee_user_id <> new.owner_user_id then
    raise exception 'Work item AI ownership mismatch';
  end if;
  if tg_table_name = 'work_item_deliverables' then
    if new.goal_id is distinct from v_item.goal_id then raise exception 'Deliverable goal mismatch'; end if;
    if new.ai_turn_id is not null and not exists (
      select 1 from public.work_item_ai_turns t where t.id = new.ai_turn_id
        and t.workspace_id = new.workspace_id and t.work_item_id = new.work_item_id
        and t.owner_user_id = new.owner_user_id and t.status = 'completed'
    ) then raise exception 'AI turn is unavailable'; end if;
    if new.based_on_id is not null and not exists (
      select 1 from public.work_item_deliverables d where d.id = new.based_on_id
        and d.workspace_id = new.workspace_id and d.work_item_id = new.work_item_id
        and d.owner_user_id = new.owner_user_id
    ) then raise exception 'Deliverable revision is unavailable'; end if;
  end if;
  return new;
end;
$$;
create trigger work_item_ai_turns_owner before insert on public.work_item_ai_turns
  for each row execute function public.validate_work_item_ai_ownership();
create trigger work_item_deliverables_owner before insert on public.work_item_deliverables
  for each row execute function public.validate_work_item_ai_ownership();

create function public.guard_work_item_ai_turn_update() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.status <> 'processing' or new.status not in ('completed','failed')
    or row(new.id,new.workspace_id,new.work_item_id,new.owner_user_id,new.request_key,new.mode,new.instruction,new.created_at)
      is distinct from row(old.id,old.workspace_id,old.work_item_id,old.owner_user_id,old.request_key,old.mode,old.instruction,old.created_at)
  then raise exception 'AI working note is immutable'; end if;
  return new;
end;
$$;
create trigger work_item_ai_turns_terminal before update on public.work_item_ai_turns
  for each row execute function public.guard_work_item_ai_turn_update();

create function public.guard_work_item_deliverable_update() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.status <> 'draft' or new.status <> 'final' or new.finalized_at is null
    or row(new.id,new.workspace_id,new.work_item_id,new.goal_id,new.owner_user_id,new.ai_turn_id,new.based_on_id,
      new.request_key,new.title,new.content,new.source_references,new.ai_assisted,new.created_at)
      is distinct from row(old.id,old.workspace_id,old.work_item_id,old.goal_id,old.owner_user_id,old.ai_turn_id,old.based_on_id,
        old.request_key,old.title,old.content,old.source_references,old.ai_assisted,old.created_at)
  then raise exception 'Final deliverable content is immutable'; end if;
  return new;
end;
$$;
create trigger work_item_deliverables_finalize before update on public.work_item_deliverables
  for each row execute function public.guard_work_item_deliverable_update();

alter table public.work_item_ai_turns enable row level security;
alter table public.work_item_ai_turns force row level security;
alter table public.work_item_deliverables enable row level security;
alter table public.work_item_deliverables force row level security;
revoke all on public.work_item_ai_turns, public.work_item_deliverables from public, anon, authenticated;
grant select on public.work_item_ai_turns, public.work_item_deliverables to authenticated;
grant select, insert, update, delete on public.work_item_ai_turns, public.work_item_deliverables to service_role;
create policy work_item_ai_turns_private_read on public.work_item_ai_turns for select to authenticated using (
  owner_user_id = (select auth.uid()) and exists (
    select 1 from public.work_items i where i.id = work_item_ai_turns.work_item_id
      and i.workspace_id = work_item_ai_turns.workspace_id and i.assignee_user_id = (select auth.uid())
  ) and exists (
    select 1 from public.workspace_memberships m where m.workspace_id = work_item_ai_turns.workspace_id
      and m.user_id = (select auth.uid()) and m.is_default
  )
);
create policy work_item_deliverables_read on public.work_item_deliverables for select to authenticated using (
  exists (select 1 from public.workspace_memberships m where m.workspace_id = work_item_deliverables.workspace_id
    and m.user_id = (select auth.uid()) and m.is_default and (
      (work_item_deliverables.owner_user_id = (select auth.uid()) and exists (
        select 1 from public.work_items i where i.id = work_item_deliverables.work_item_id
          and i.assignee_user_id = (select auth.uid()) and i.workspace_id = work_item_deliverables.workspace_id
      )) or (work_item_deliverables.status = 'final' and work_item_deliverables.goal_id is not null
        and m.role in ('owner','admin'))
    ))
);

alter table public.activity_events drop constraint activity_events_event_type_check;
alter table public.activity_events add constraint activity_events_event_type_check check (event_type in (
  'work_item_created', 'work_item_needs_you', 'work_item_in_progress', 'work_item_waiting',
  'work_item_blocked', 'work_item_handled', 'work_item_done', 'work_item_reassigned',
  'work_item_due_changed', 'ai_work_started', 'work_result_saved', 'work_result_finalized',
  'approval_requested', 'approval_approved', 'approval_rejected', 'approval_cancelled',
  'action_proposed', 'action_queued', 'action_executing', 'action_succeeded',
  'action_failed', 'action_ambiguous', 'action_rejected', 'action_cancelled',
  'workflow_succeeded', 'workflow_failed', 'goal_created', 'goal_plan_proposed',
  'goal_plan_approved', 'goal_activated', 'goal_completed', 'goal_cancelled'
));

create function public.record_work_item_ai_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_event text; v_visibility text;
begin
  if tg_table_name = 'work_item_ai_turns' then
    if tg_op <> 'INSERT' then return new; end if;
    v_event := 'ai_work_started';
  else
    if tg_op = 'INSERT' then v_event := 'work_result_saved';
    elsif old.status = 'draft' and new.status = 'final' then v_event := 'work_result_finalized';
    else return new; end if;
  end if;
  insert into public.activity_events(workspace_id, owner_user_id, actor_user_id, visibility,
    event_type, source_type, source_id, work_item_id, goal_id, event_key, occurred_at)
  values (new.workspace_id, new.owner_user_id, new.owner_user_id, 'private', v_event,
    'work_item', new.work_item_id, new.work_item_id,
    case when tg_table_name = 'work_item_deliverables' then new.goal_id else null end,
    'workbench:' || new.id::text || ':' || v_event, clock_timestamp())
  on conflict (workspace_id, event_key) do nothing;
  if v_event = 'work_result_finalized' and new.goal_id is not null then
    insert into public.activity_events(workspace_id, owner_user_id, actor_user_id, visibility,
      event_type, source_type, source_id, work_item_id, goal_id, event_key, occurred_at)
    values (new.workspace_id, new.owner_user_id, new.owner_user_id, 'workspace', v_event,
      'work_item', new.work_item_id, new.work_item_id, new.goal_id,
      'shared-workbench:' || new.id::text || ':' || v_event, clock_timestamp())
    on conflict (workspace_id, event_key) do nothing;
  end if;
  return new;
end;
$$;
create trigger work_item_ai_turn_activity after insert on public.work_item_ai_turns
  for each row execute function public.record_work_item_ai_activity();
create trigger work_item_deliverable_activity after insert or update on public.work_item_deliverables
  for each row execute function public.record_work_item_ai_activity();
revoke all on function public.validate_work_item_ai_ownership() from public, anon, authenticated;
revoke all on function public.guard_work_item_ai_turn_update() from public, anon, authenticated;
revoke all on function public.guard_work_item_deliverable_update() from public, anon, authenticated;
revoke all on function public.record_work_item_ai_activity() from public, anon, authenticated;

commit;
