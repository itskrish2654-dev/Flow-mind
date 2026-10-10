-- Acceptance-only database contract check; never contacts Gmail or commits fixtures.
begin;
set local role service_role;

do $acceptance$
declare
  v_workspace uuid;
  v_owner uuid;
  v_other uuid;
  v_connection uuid;
  v_workflow uuid;
  v_version uuid;
  v_suggestion uuid;
  v_item uuid;
  v_execution uuid;
  v_action uuid;
  v_repeat uuid;
  v_snapshot jsonb := jsonb_build_object(
    'version', 1, 'operationKey', 'gmail_send_email',
    'target', jsonb_build_object('kind', 'external_resource',
      'label', 'acceptance@example.invalid', 'reference', 'acceptance@example.invalid'),
    'parameters', jsonb_build_array(
      jsonb_build_object('name', 'to', 'label', 'To', 'value', 'acceptance@example.invalid'),
      jsonb_build_object('name', 'subject', 'label', 'Subject', 'value', 'Acceptance draft'),
      jsonb_build_object('name', 'body', 'label', 'Email body', 'value', 'Prepared but never sent.')));
begin
  select c.workspace_id, c.user_id, c.id into v_workspace, v_owner, v_connection
    from public.connector_connections c
    where c.provider_family = 'google' and c.status = 'connected'
      and c.granted_scopes @> array['https://www.googleapis.com/auth/gmail.send']::text[]
    order by c.id limit 1;
  select user_id into v_other from public.workspace_memberships
    where is_default and user_id <> v_owner order by user_id limit 1;
  if v_connection is null or v_other is null then
    raise exception 'Disposable acceptance connection and second member are required';
  end if;
  insert into public.workflows(user_id, name, prompt, compiled_steps)
    values (v_owner, 'Automate This approval acceptance',
      'Transaction-rolled-back approval test', '{"steps":[]}'::jsonb)
    returning id into v_workflow;
  insert into public.workflow_versions(workflow_id, user_id, version_number,
    compiled_workflow, setup_config, change_scope, created_by)
    values (v_workflow, v_owner, 1, '{"steps":[]}'::jsonb, '{}'::jsonb,
      'initial', v_owner) returning id into v_version;
  update public.workflows set current_version_id = v_version where id = v_workflow;
  perform * from public.publish_workflow_version(v_workflow, v_owner, v_version,
    true, 'honeypot', '[]'::jsonb, null);
  insert into public.automation_suggestions(workspace_id, owner_user_id,
    pattern_key, pattern_kind, source_type, source_title, evidence_count,
    evidence_item_ids, evidence_first_at, evidence_last_at, status, workflow_id)
    values (v_workspace, v_owner, encode(gen_random_bytes(32), 'hex'),
      'gmail_follow_up', 'internal', 'Customer has not replied', 3,
      array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()],
      clock_timestamp() - interval '3 days', clock_timestamp(), 'active', v_workflow)
    returning id into v_suggestion;
  insert into public.work_items(workspace_id, assignee_user_id, title,
    source_type, status, priority) values (v_workspace, v_owner,
      'Customer has not replied', 'internal', 'waiting', 'normal')
    returning id into v_item;
  select execution_id into v_execution from public.create_execution_once(
    v_workflow, v_version, v_owner, 'work_item', '{}'::jsonb,
    'automate-this-approval-acceptance', '{}'::jsonb);
  update public.workflow_executions set status = 'succeeded',
    started_at = clock_timestamp(), completed_at = clock_timestamp(),
    output_data = '{"status":"succeeded"}'::jsonb where id = v_execution;
  insert into public.automation_work_item_runs(workspace_id, owner_user_id,
    suggestion_id, workflow_id, workflow_version_id, work_item_id,
    status, attempt_count, execution_id) values (v_workspace, v_owner,
      v_suggestion, v_workflow, v_version, v_item, 'succeeded', 1, v_execution);

  select id into v_action from public.create_automation_action_approval(
    v_owner, v_execution, 'automation-action:' || v_execution::text,
    'Review prepared Gmail follow-up', 'Nothing has been sent.',
    'Approve exact recipient, subject, and body.', v_connection, v_snapshot);
  if v_action is null or not exists (select 1 from public.action_executions a
    join public.approval_requests p on p.id = a.approval_request_id
    where a.id = v_action and a.status = 'pending_approval'
      and p.status = 'pending' and p.action_snapshot = v_snapshot)
  then raise exception 'Exact approval was not persisted'; end if;
  select id into v_repeat from public.create_automation_action_approval(
    v_owner, v_execution, 'automation-action:' || v_execution::text,
    'Review prepared Gmail follow-up', 'Nothing has been sent.',
    'Approve exact recipient, subject, and body.', v_connection, v_snapshot);
  if v_repeat is distinct from v_action then raise exception 'Approval replay duplicated the action'; end if;

  begin
    perform * from public.create_automation_action_approval(
      v_other, v_execution, 'automation-action:' || v_execution::text,
      'Review prepared Gmail follow-up', 'Nothing has been sent.',
      'Approve exact recipient, subject, and body.', v_connection, v_snapshot);
    raise exception 'Cross-owner approval was accepted';
  exception when others then
    if sqlerrm = 'Cross-owner approval was accepted' then raise; end if;
  end;
end;
$acceptance$;

rollback;
