begin;
set local statement_timeout = '25s';
set local lock_timeout = '8s';
set local role service_role;

do $$
declare v_owner uuid; v_other uuid; v_workspace uuid; v_other_workspace uuid; v_goal uuid;
begin
  if (select count(*) from public.goals) <> 0 then raise exception 'Goal baseline is not empty'; end if;
  select user_id, workspace_id into v_owner, v_workspace
    from public.workspace_memberships where is_default and role in ('owner', 'admin')
    order by user_id limit 1;
  select user_id, workspace_id into v_other, v_other_workspace
    from public.workspace_memberships where is_default and workspace_id <> v_workspace
    order by user_id limit 1;
  if v_owner is null or v_other is null then raise exception 'Two acceptance tenants required'; end if;
  perform set_config('goals.owner', v_owner::text, true);
  perform set_config('goals.other', v_other::text, true);
  perform set_config('goals.workspace', v_workspace::text, true);
  perform set_config('goals.other_workspace', v_other_workspace::text, true);
  insert into public.goals(workspace_id, created_by_user_id, owner_user_id,
    last_actor_user_id, request_key, request_hash, title, success_criteria, target_date)
  values (v_workspace, v_owner, v_owner, v_owner, gen_random_uuid(), repeat('a', 64),
    'Hire 3 customer support agents', 'Three candidates accepted written offers', '2026-11-30')
  returning id into v_goal;
  perform set_config('goals.id', v_goal::text, true);
  if (select count(*) from public.activity_events where goal_id = v_goal and event_type = 'goal_created') <> 2
  then raise exception 'Goal creation Activity missing'; end if;
  if has_table_privilege('authenticated', 'public.goals', 'INSERT')
    or has_table_privilege('authenticated', 'public.goal_plans', 'UPDATE')
    or has_table_privilege('authenticated', 'public.goal_plan_items', 'INSERT')
    or has_function_privilege('authenticated', 'public.save_goal_plan(uuid,uuid,integer,text,jsonb,uuid[])', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.activate_goal_plan(uuid,uuid,uuid,integer)', 'EXECUTE')
  then raise exception 'Browser mutation grant exists'; end if;
  begin
    perform public.save_goal_plan(v_owner, v_goal, 0, 'manager',
      jsonb_build_array(jsonb_build_object('title','Review applicants','assigneeUserId',v_other)), '{}');
    raise exception 'Non-member assignee was accepted';
  exception when others then
    if sqlerrm = 'Non-member assignee was accepted' then raise; end if;
  end;
  if (select count(*) from public.goal_plans where goal_id = v_goal) <> 0
  then raise exception 'Invalid proposal left a partial plan'; end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('goals.other'), true);
do $$
begin
  if (select count(*) from public.goals where id = current_setting('goals.id')::uuid) <> 0
  then raise exception 'Other workspace can read goal'; end if;
  begin
    perform public.activate_goal_plan(current_setting('goals.other')::uuid,
      current_setting('goals.id')::uuid, gen_random_uuid(), 1);
    raise exception 'Browser called privileged activation RPC';
  exception when others then
    if sqlerrm = 'Browser called privileged activation RPC' then raise; end if;
  end;
end;
$$;

set local role service_role;
update public.workspace_memberships set is_default = false
  where workspace_id = current_setting('goals.other_workspace')::uuid
    and user_id = current_setting('goals.other')::uuid;
insert into public.workspace_memberships(workspace_id, user_id, role, is_default)
values (current_setting('goals.workspace')::uuid, current_setting('goals.other')::uuid, 'member', true);

do $$
declare v_goal uuid := current_setting('goals.id')::uuid;
declare v_owner uuid := current_setting('goals.owner')::uuid;
declare v_other uuid := current_setting('goals.other')::uuid;
declare v_plan uuid;
declare v_item_one uuid;
declare v_item_two uuid;
begin
  select public.save_goal_plan(v_owner, v_goal, 0, 'manager', jsonb_build_array(
    jsonb_build_object('title','Finalize role description','assigneeUserId',v_owner,'priority','normal'),
    jsonb_build_object('title','Review applicants','assigneeUserId',v_other,'priority','high')
  ), '{}') into v_plan;
  if (select count(*) from public.work_items where goal_id = v_goal) <> 0
  then raise exception 'Work was created before approval'; end if;
  if (select status from public.goals where id = v_goal) <> 'awaiting_approval'
  then raise exception 'Proposal did not await approval'; end if;
  begin
    perform public.activate_goal_plan(v_other, v_goal, v_plan, 1);
    raise exception 'Member activated a manager goal';
  exception when others then
    if sqlerrm = 'Member activated a manager goal' then raise; end if;
  end;
  if (select count(*) from public.work_items where goal_id = v_goal) <> 0
  then raise exception 'Denied activation created work'; end if;
  perform public.activate_goal_plan(v_owner, v_goal, v_plan, 1);
  perform public.activate_goal_plan(v_owner, v_goal, v_plan, 1);
  if (select count(*) from public.work_items where goal_id = v_goal) <> 2
    or (select count(*) from public.goal_plan_items where plan_id = v_plan) <> 2
    or (select status from public.goal_plans where id = v_plan) <> 'approved'
    or (select approved_plan_id from public.goals where id = v_goal) <> v_plan
  then raise exception 'Activation was not atomic/idempotent'; end if;
  if (select count(*) from public.activity_events where goal_id = v_goal and event_type = 'goal_activated') <> 2
    or (select count(*) from public.activity_events where goal_id = v_goal and event_type = 'goal_plan_approved') <> 2
  then raise exception 'Approval trust chain missing'; end if;
  select w.id into v_item_one from public.work_items w
    join public.goal_plan_items i on i.id = w.goal_plan_item_id
    where w.goal_id = v_goal and i.position = 1;
  select w.id into v_item_two from public.work_items w
    join public.goal_plan_items i on i.id = w.goal_plan_item_id
    where w.goal_id = v_goal and i.position = 2;
  update public.work_items set status = 'done', resolved_at = clock_timestamp() where id = v_item_one;
  if (select count(*) from public.work_items where goal_id = v_goal and status = 'done') <> 1
  then raise exception 'Progress did not reflect first completed item'; end if;
  begin
    perform public.finish_goal(v_owner, v_goal, 'complete');
    raise exception 'Goal completed with unfinished work';
  exception when others then
    if sqlerrm = 'Goal completed with unfinished work' then raise; end if;
  end;
  update public.work_items set status = 'done', resolved_at = clock_timestamp() where id = v_item_two;
  perform public.finish_goal(v_owner, v_goal, 'complete');
  if (select status from public.goals where id = v_goal) <> 'completed'
    or (select count(*) from public.activity_events where goal_id = v_goal and event_type = 'goal_completed') <> 2
  then raise exception 'Goal completion was not durable'; end if;
  begin
    update public.goal_plan_items set title = 'Changed after approval' where plan_id = v_plan;
    raise exception 'Approved plan mutated';
  exception when others then
    if sqlerrm = 'Approved plan mutated' then raise; end if;
  end;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('goals.other'), true);
do $$
begin
  if (select count(*) from public.goals where id = current_setting('goals.id')::uuid) <> 1
    or (select count(*) from public.goal_plan_items where goal_id = current_setting('goals.id')::uuid) <> 2
    or (select count(*) from public.work_items where goal_id = current_setting('goals.id')::uuid
      and assignee_user_id = current_setting('goals.owner')::uuid) <> 0
    or (select count(*) from public.work_items where goal_id = current_setting('goals.id')::uuid
      and assignee_user_id = current_setting('goals.other')::uuid) <> 1
  then raise exception 'Workspace goal or individual My Day isolation failed'; end if;
end;
$$;

set local role service_role;
select 'PASS' as goals_runtime_acceptance;
rollback;
