begin;
set local statement_timeout = '20s';
set local lock_timeout = '10s';
set local role service_role;

do $$
declare
  v_a uuid;
  v_b uuid;
  v_workspace_a uuid;
  v_workspace_b uuid;
  v_item uuid;
  v_action uuid;
  v_approval uuid;
  v_claim uuid;
  v_workflow uuid;
  v_execution_success uuid;
  v_execution_failure uuid;
  v_before bigint;
  v_tag text := gen_random_uuid()::text;
begin
  if (select count(*) from public.activity_events) <> 0
  then raise exception 'Activity baseline is not empty'; end if;
  select user_id, workspace_id into v_a, v_workspace_a
    from public.workspace_memberships where is_default order by user_id limit 1;
  select user_id, workspace_id into v_b, v_workspace_b
    from public.workspace_memberships where is_default and user_id <> v_a
      and workspace_id <> v_workspace_a order by user_id limit 1;
  if v_a = v_b or v_workspace_a = v_workspace_b then raise exception 'Two distinct acceptance tenants required'; end if;
  perform set_config('activity.test_user_a', v_a::text, true);
  perform set_config('activity.test_user_b', v_b::text, true);
  perform set_config('activity.test_workspace_a', v_workspace_a::text, true);
  perform set_config('activity.test_workspace_b', v_workspace_b::text, true);

  insert into public.work_items(workspace_id, assignee_user_id, title, status,
    source_type, dedupe_key)
  values (v_workspace_a, v_a, 'Disposable activity work', 'needs_you',
    'internal', 'activity-acceptance-work-' || v_tag) returning id into v_item;
  if (select count(*) from public.activity_events where work_item_id = v_item
    and event_type = 'work_item_created' and visibility = 'private') <> 1
  then raise exception 'Work item creation was not recorded'; end if;
  update public.work_items set status = 'waiting', updated_at = clock_timestamp()
    where id = v_item;
  update public.work_items set status = 'needs_you', updated_at = clock_timestamp()
    where id = v_item;
  select count(*) into v_before from public.activity_events where work_item_id = v_item;
  update public.work_items set summary = 'Safe updated summary', updated_at = clock_timestamp()
    where id = v_item;
  if (select count(*) from public.activity_events where work_item_id = v_item) <> v_before
  then raise exception 'No-op status update duplicated Activity'; end if;
  if (select count(*) from public.activity_events where work_item_id = v_item) <> 3
  then raise exception 'Work item transitions were not preserved'; end if;

  select id into strict v_action from public.create_action_approval(
    v_a, gen_random_uuid(), 'activity-acceptance-action-' || v_tag,
    'Disposable approved action', 'Safe approved action summary',
    'Approval required before delivery', 'internal.action_acknowledge',
    'flowmind_test', 'acknowledge', 1, null,
    '{"version":1,"operationKey":"internal.action_acknowledge","target":{"kind":"internal_record","label":"Disposable acceptance target","reference":"fixture"},"parameters":[]}'::jsonb
  );
  select approval_request_id into strict v_approval from public.action_executions where id = v_action;
  if (select count(*) from public.activity_events where action_execution_id = v_action
    and event_type = 'action_proposed') <> 1
  then raise exception 'Action proposal not recorded'; end if;
  perform * from public.decide_action_execution(v_approval, v_a, 'approved', null);
  if (select count(*) from public.activity_events where approval_request_id = v_approval
    and event_type = 'approval_approved' and visibility = 'private') <> 1
  then raise exception 'Approval decision not recorded'; end if;
  select claim_token into strict v_claim from public.claim_action_execution(v_action, v_a);
  perform * from public.complete_action_execution(
    v_action, v_claim, 'succeeded', true, true, 'FAKE_PROVIDER_REFERENCE_DO_NOT_COPY',
    'Provider acknowledged disposable action', null, null
  );
  if (select count(*) from public.activity_events where action_execution_id = v_action
    and event_type = 'action_succeeded' and visibility = 'private') <> 1
    or (select count(*) from public.activity_events where action_execution_id = v_action
      and event_type = 'action_succeeded' and visibility = 'workspace') <> 1
    or (select status from public.work_items where id =
      (select work_item_id from public.action_executions where id = v_action)) <> 'handled'
  then raise exception 'Confirmed action chain or My Day state is inconsistent'; end if;
  if (select count(*) from public.activity_events where event_key like '%FAKE_PROVIDER_REFERENCE%') <> 0
  then raise exception 'Provider reference copied into Activity'; end if;
  if has_table_privilege('authenticated', 'public.activity_events', 'INSERT')
    or has_table_privilege('authenticated', 'public.activity_events', 'UPDATE')
    or has_table_privilege('authenticated', 'public.activity_events', 'DELETE')
    or has_function_privilege('authenticated', 'public.record_action_activity()', 'EXECUTE')
  then raise exception 'Browser mutation grant exists'; end if;

  insert into public.workflows(name, prompt, user_id, workspace_id)
    values ('Disposable Activity workflow', 'Acceptance fixture only', v_a, v_workspace_a)
    returning id into v_workflow;
  insert into public.workflow_executions(
    workflow_id, user_id, trigger_type, idempotency_key, status
  ) values (
    v_workflow, v_a, 'manual', 'activity-success-' || v_tag, 'queued'
  ) returning id into v_execution_success;
  update public.workflow_executions set status = 'succeeded',
    completed_at = clock_timestamp() where id = v_execution_success;
  insert into public.workflow_executions(
    workflow_id, user_id, trigger_type, idempotency_key, status
  ) values (
    v_workflow, v_a, 'manual', 'activity-failure-' || v_tag, 'queued'
  ) returning id into v_execution_failure;
  update public.workflow_executions set status = 'failed',
    completed_at = clock_timestamp(), failure_category = 'acceptance_fixture'
    where id = v_execution_failure;
  if (select count(*) from public.activity_events where source_id = v_execution_success
      and event_type = 'workflow_succeeded' and visibility = 'private') <> 1
    or (select count(*) from public.activity_events where source_id = v_execution_failure
      and event_type = 'workflow_failed' and visibility = 'private') <> 1
  then raise exception 'Workflow outcomes did not produce distinct private events'; end if;

  -- Another tenant's private event must never become visible to A.
  insert into public.work_items(workspace_id, assignee_user_id, title, status,
    source_type, dedupe_key)
  values (v_workspace_b, v_b, 'Other tenant private work', 'needs_you',
    'internal', 'activity-acceptance-other-tenant-' || v_tag);

  -- Temporarily make B an admin in A's workspace, exercising the strongest
  -- same-workspace privacy case without changing any lasting membership.
  update public.workspace_memberships set is_default = false
    where workspace_id = v_workspace_b and user_id = v_b;
  insert into public.workspace_memberships(workspace_id, user_id, role, is_default)
    values (v_workspace_a, v_b, 'admin', true);
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('activity.test_user_b'), true);
do $$
declare v_workspace_a uuid := current_setting('activity.test_workspace_a')::uuid;
declare v_user_a uuid := current_setting('activity.test_user_a')::uuid;
begin
  if (select count(*) from public.activity_events where workspace_id = v_workspace_a
    and visibility = 'workspace' and event_type = 'action_succeeded') <> 1
  then raise exception 'Admin could not see one company-safe outcome'; end if;
  if (select count(*) from public.activity_events where workspace_id = v_workspace_a
    and owner_user_id = v_user_a and visibility = 'private') <> 0
    or (select count(*) from public.action_executions where requester_user_id = v_user_a) <> 0
    or (select count(*) from public.approval_requests where approver_user_id = v_user_a) <> 0
  then raise exception 'Admin crossed another user private boundary'; end if;
end;
$$;

set local role service_role;
update public.workspace_memberships set role = 'member'
  where workspace_id = current_setting('activity.test_workspace_a')::uuid
    and user_id = current_setting('activity.test_user_b')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('activity.test_user_b'), true);
do $$
begin
  if (select count(*) from public.activity_events
    where workspace_id = current_setting('activity.test_workspace_a')::uuid
      and visibility = 'workspace') <> 1
    or (select count(*) from public.activity_events
      where workspace_id = current_setting('activity.test_workspace_a')::uuid
        and visibility = 'private') <> 0
  then raise exception 'Member visibility is not company-safe'; end if;
end;
$$;

set local role service_role;
insert into public.activity_events (
  workspace_id, owner_user_id, actor_user_id, visibility, event_type,
  source_type, source_id, event_key
) values (
  current_setting('activity.test_workspace_a')::uuid,
  current_setting('activity.test_user_b')::uuid,
  current_setting('activity.test_user_b')::uuid,
  'workspace', 'action_succeeded', 'action', gen_random_uuid(),
  'member-departure-fixture:' || gen_random_uuid()::text
);
delete from public.workspace_memberships
  where workspace_id = current_setting('activity.test_workspace_a')::uuid
    and user_id = current_setting('activity.test_user_b')::uuid;
do $$
begin
  if (select count(*) from public.activity_events
    where workspace_id = current_setting('activity.test_workspace_a')::uuid
      and owner_user_id = current_setting('activity.test_user_b')::uuid
      and event_type = 'action_succeeded' and visibility = 'workspace') <> 1
  then raise exception 'Membership departure erased company-safe Activity history'; end if;
end;
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('activity.test_user_a'), true);
do $$
begin
  if (select count(*) from public.activity_events
    where workspace_id = current_setting('activity.test_workspace_a')::uuid
      and owner_user_id = current_setting('activity.test_user_b')::uuid
      and event_type = 'action_succeeded' and visibility = 'workspace') <> 1
  then raise exception 'Remaining member lost legitimate shared history'; end if;
end;
$$;
set local role service_role;
select 'PASS' as activity_runtime_acceptance;
rollback;
