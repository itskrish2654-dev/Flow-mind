begin;

-- AI turns have no goal_id column. Resolve the event goal only for deliverables
-- before constructing the common Activity insert statement.
create or replace function public.record_work_item_ai_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_event text; v_goal_id uuid;
begin
  if tg_table_name = 'work_item_ai_turns' then
    if tg_op <> 'INSERT' then return new; end if;
    v_event := 'ai_work_started';
    v_goal_id := null;
  else
    v_goal_id := new.goal_id;
    if tg_op = 'INSERT' then v_event := 'work_result_saved';
    elsif old.status = 'draft' and new.status = 'final' then v_event := 'work_result_finalized';
    else return new; end if;
  end if;
  insert into public.activity_events(workspace_id, owner_user_id, actor_user_id, visibility,
    event_type, source_type, source_id, work_item_id, goal_id, event_key, occurred_at)
  values (new.workspace_id, new.owner_user_id, new.owner_user_id, 'private', v_event,
    'work_item', new.work_item_id, new.work_item_id, v_goal_id,
    'workbench:' || new.id::text || ':' || v_event, clock_timestamp())
  on conflict (workspace_id, event_key) do nothing;
  if v_event = 'work_result_finalized' and v_goal_id is not null then
    insert into public.activity_events(workspace_id, owner_user_id, actor_user_id, visibility,
      event_type, source_type, source_id, work_item_id, goal_id, event_key, occurred_at)
    values (new.workspace_id, new.owner_user_id, new.owner_user_id, 'workspace', v_event,
      'work_item', new.work_item_id, new.work_item_id, v_goal_id,
      'shared-workbench:' || new.id::text || ':' || v_event, clock_timestamp())
    on conflict (workspace_id, event_key) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.record_work_item_ai_activity() from public, anon, authenticated;

commit;
