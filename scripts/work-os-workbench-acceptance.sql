-- Run only against the authorized acceptance project. Every fixture rolls back.
begin;

insert into public.work_item_ai_turns(workspace_id, work_item_id, owner_user_id,
  request_key, mode, instruction, status, response_title, response_content, finished_at)
select workspace_id, id, assignee_user_id, gen_random_uuid(), 'RESEARCH',
  'acceptance-private-workbench-probe', 'completed', 'Probe', 'No provider claim', clock_timestamp()
from public.work_items order by created_at limit 1;

insert into public.work_item_deliverables(workspace_id, work_item_id, goal_id,
  owner_user_id, ai_turn_id, request_key, title, content)
select workspace_id, work_item_id, null, owner_user_id, id, gen_random_uuid(),
  'acceptance-workbench-result-probe', 'Employee reviewed result'
from public.work_item_ai_turns where instruction = 'acceptance-private-workbench-probe';

update public.work_item_deliverables set status = 'final', finalized_at = clock_timestamp()
where title = 'acceptance-workbench-result-probe';

select set_config('request.jwt.claim.sub',
  (select owner_user_id::text from public.work_item_ai_turns
    where instruction = 'acceptance-private-workbench-probe'), true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.work_item_ai_turns
    where instruction = 'acceptance-private-workbench-probe') <> 1 then
    raise exception 'Assigned employee cannot read own private AI turn';
  end if;
  if (select count(*) from public.work_item_deliverables
    where title = 'acceptance-workbench-result-probe' and status = 'final') <> 1 then
    raise exception 'Assigned employee cannot read final result';
  end if;
  if (select count(*) from public.activity_events
    where event_key like 'workbench:%' and work_item_id = (
      select work_item_id from public.work_item_ai_turns
        where instruction = 'acceptance-private-workbench-probe')) < 2 then
    raise exception 'Private workbench Activity is missing';
  end if;
end $$;
reset role;

select set_config('request.jwt.claim.sub',
  (select id::text from auth.users where id <> (
    select owner_user_id from public.work_item_ai_turns
      where instruction = 'acceptance-private-workbench-probe') limit 1), true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.work_item_ai_turns
    where instruction = 'acceptance-private-workbench-probe') <> 0 then
    raise exception 'Another employee can read private AI turn';
  end if;
  if (select count(*) from public.work_item_deliverables
    where title = 'acceptance-workbench-result-probe') <> 0 then
    raise exception 'Another workspace can read final result';
  end if;
end $$;
reset role;

rollback;
