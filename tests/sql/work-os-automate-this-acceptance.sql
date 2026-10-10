-- Run only against the authorized disposable acceptance database.
-- Every fixture and state change rolls back, including successful assertions.
begin;
set local role service_role;

do $acceptance$
declare
  v_workspace uuid;
  v_owner uuid;
  v_other uuid;
  v_workflow uuid;
  v_version uuid;
  v_suggestion uuid;
  v_item uuid;
  v_run uuid;
  v_claim record;
begin
  select workspace_id, user_id into v_workspace, v_owner
    from public.workspace_memberships where is_default
    order by workspace_id, user_id limit 1;
  select user_id into v_other from public.workspace_memberships
    where is_default and user_id <> v_owner order by user_id limit 1;
  if v_workspace is null or v_other is null then
    raise exception 'Two disposable acceptance members are required';
  end if;

  insert into public.workflows(user_id, name, prompt, compiled_steps)
    values (v_owner, 'Automate This claim acceptance', 'Transaction-rolled-back claim test', '{}'::jsonb)
    returning id into v_workflow;
  insert into public.workflow_versions(workflow_id, user_id, version_number,
    compiled_workflow, setup_config, change_scope, created_by)
    values (v_workflow, v_owner, 1, '{}'::jsonb,
      jsonb_build_object('automate_this', jsonb_build_object(
        'kind', 'work_item_ai_result', 'matchTitle', 'Prepare manager status update',
        'sourceType', 'internal', 'instruction', 'Prepare the assigned update.')::text),
      'initial', v_owner) returning id into v_version;
  update public.workflows set current_version_id = v_version where id = v_workflow;
  perform * from public.publish_workflow_version(v_workflow, v_owner, v_version,
    true, 'honeypot', '[]'::jsonb, null);
  insert into public.automation_suggestions(workspace_id, owner_user_id,
    pattern_key, pattern_kind, source_type, source_title, evidence_count,
    evidence_item_ids, evidence_first_at, evidence_last_at, status, workflow_id)
    values (v_workspace, v_owner, encode(gen_random_bytes(32), 'hex'),
      'work_item_ai_result', 'internal', 'Prepare manager status update', 3,
      array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()],
      clock_timestamp() - interval '3 days', clock_timestamp(), 'active', v_workflow)
    returning id into v_suggestion;

  insert into public.work_items(workspace_id, assignee_user_id, title, source_type,
    status, priority) values (v_workspace, v_owner, 'Prepare manager status update',
      'internal', 'needs_you', 'normal') returning id into v_item;
  insert into public.automation_work_item_runs(workspace_id, owner_user_id,
    suggestion_id, workflow_id, workflow_version_id, work_item_id)
    values (v_workspace, v_owner, v_suggestion, v_workflow, v_version, v_item)
    returning id into v_run;
  select * into v_claim from public.claim_automation_work_item_run(v_run, v_owner);
  if not v_claim.claimed or v_claim.claim_token is null then
    raise exception 'Eligible assigned work was not claimed';
  end if;
  select * into v_claim from public.claim_automation_work_item_run(v_run, v_owner);
  if v_claim.claimed then raise exception 'Active lease was claimed twice'; end if;

  insert into public.work_items(workspace_id, assignee_user_id, title, source_type,
    status, priority) values (v_workspace, v_owner, 'Unrelated manager update',
      'internal', 'needs_you', 'normal') returning id into v_item;
  insert into public.automation_work_item_runs(workspace_id, owner_user_id,
    suggestion_id, workflow_id, workflow_version_id, work_item_id)
    values (v_workspace, v_owner, v_suggestion, v_workflow, v_version, v_item)
    returning id into v_run;
  select * into v_claim from public.claim_automation_work_item_run(v_run, v_owner);
  if v_claim.claimed then raise exception 'Different title crossed reviewed pattern'; end if;

  insert into public.work_items(workspace_id, assignee_user_id, title, source_type,
    status, priority, resolved_at) values (v_workspace, v_owner,
      'Prepare manager status update', 'internal', 'done', 'normal', clock_timestamp())
    returning id into v_item;
  insert into public.automation_work_item_runs(workspace_id, owner_user_id,
    suggestion_id, workflow_id, workflow_version_id, work_item_id)
    values (v_workspace, v_owner, v_suggestion, v_workflow, v_version, v_item)
    returning id into v_run;
  select * into v_claim from public.claim_automation_work_item_run(v_run, v_owner);
  if v_claim.claimed then raise exception 'Completed work was claimed'; end if;

  insert into public.work_items(workspace_id, assignee_user_id, title, source_type,
    status, priority, created_at) values (v_workspace, v_owner,
      'Prepare manager status update', 'internal', 'needs_you', 'normal',
      clock_timestamp() - interval '2 days') returning id into v_item;
  insert into public.automation_work_item_runs(workspace_id, owner_user_id,
    suggestion_id, workflow_id, workflow_version_id, work_item_id)
    values (v_workspace, v_owner, v_suggestion, v_workflow, v_version, v_item)
    returning id into v_run;
  select * into v_claim from public.claim_automation_work_item_run(v_run, v_owner);
  if v_claim.claimed then raise exception 'Pre-publication work was claimed'; end if;

  update public.automation_suggestions set status = 'paused' where id = v_suggestion;
  insert into public.work_items(workspace_id, assignee_user_id, title, source_type,
    status, priority) values (v_workspace, v_owner,
      'Prepare manager status update', 'internal', 'needs_you', 'normal')
    returning id into v_item;
  insert into public.automation_work_item_runs(workspace_id, owner_user_id,
    suggestion_id, workflow_id, workflow_version_id, work_item_id)
    values (v_workspace, v_owner, v_suggestion, v_workflow, v_version, v_item)
    returning id into v_run;
  select * into v_claim from public.claim_automation_work_item_run(v_run, v_owner);
  if v_claim.claimed then raise exception 'Paused suggestion claimed work'; end if;

  begin
    perform * from public.claim_automation_work_item_run(v_run, v_other);
    raise exception 'Cross-owner claim was accepted';
  exception when others then
    if sqlerrm = 'Cross-owner claim was accepted' then raise; end if;
  end;
end;
$acceptance$;

rollback;
