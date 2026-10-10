begin;

-- Preserve provenance when an employee sends a finalized Workbench result to
-- Ask for an exact Gmail preview. A provider-confirmed action is still required
-- before this can count as repeated follow-up evidence.
create table public.automation_workbench_handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  owner_user_id uuid not null,
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  ask_turn_id uuid not null unique references public.ask_turns(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  constraint automation_workbench_handoffs_owner_fkey foreign key (workspace_id, owner_user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade
);
create index automation_workbench_handoffs_owner_idx
  on public.automation_workbench_handoffs(workspace_id, owner_user_id, work_item_id);
create index automation_workbench_handoffs_work_item_idx
  on public.automation_workbench_handoffs(work_item_id);
alter table public.automation_workbench_handoffs enable row level security;
alter table public.automation_workbench_handoffs force row level security;
revoke all on public.automation_workbench_handoffs from public, anon, authenticated;
grant select, insert, delete on public.automation_workbench_handoffs to service_role;
create function public.validate_automation_workbench_handoff() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user <> 'service_role' or not exists (
    select 1 from public.work_items i
    join public.ask_turns t on t.id = new.ask_turn_id
    where i.id = new.work_item_id and i.workspace_id = new.workspace_id
      and i.assignee_user_id = new.owner_user_id
      and t.workspace_id = new.workspace_id and t.user_id = new.owner_user_id
      and t.state = 'completed'
      and exists (select 1 from public.work_item_deliverables d
        where d.work_item_id = i.id and d.workspace_id = new.workspace_id
          and d.owner_user_id = new.owner_user_id and d.status = 'final')
      and exists (select 1 from public.ask_messages m
        where m.turn_id = t.id and m.workspace_id = new.workspace_id
          and m.user_id = new.owner_user_id and m.role = 'assistant'
          and m.response_metadata ->> 'responseType' = 'action_preview'
          and m.response_metadata -> 'actionPreview' ->> 'capabilityId' = 'gmail_send_email')
  ) then raise exception 'Workbench Gmail handoff is unavailable'; end if;
  return new;
end;
$$;
create trigger automation_workbench_handoff_validate before insert
  on public.automation_workbench_handoffs for each row
  execute function public.validate_automation_workbench_handoff();
revoke all on function public.validate_automation_workbench_handoff() from public, anon, authenticated;

-- Suggestions are private, evidence-backed proposals. They cannot publish or run a workflow.
create table public.automation_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  owner_user_id uuid not null,
  pattern_key text not null check (pattern_key ~ '^[0-9a-f]{64}$'),
  pattern_kind text not null check (pattern_kind in ('gmail_follow_up', 'work_item_ai_result')),
  source_type text not null check (source_type in ('workflow', 'workflow_execution', 'connector_event', 'system', 'internal')),
  source_title text not null check (char_length(trim(source_title)) between 5 and 180),
  evidence_count integer not null check (evidence_count between 3 and 100),
  evidence_item_ids uuid[] not null check (cardinality(evidence_item_ids) between 3 and 12),
  evidence_first_at timestamptz not null,
  evidence_last_at timestamptz not null,
  status text not null default 'suggested' check (status in ('suggested', 'dismissed', 'accepted', 'configured', 'active', 'paused', 'disabled')),
  workflow_id uuid references public.workflows(id) on delete set null,
  configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(configuration) = 'object' and octet_length(configuration::text) <= 4000),
  dismissed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint automation_suggestions_evidence_window check (evidence_first_at <= evidence_last_at),
  constraint automation_suggestions_owner_fkey foreign key (workspace_id, owner_user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade,
  constraint automation_suggestions_identity unique (workspace_id, owner_user_id, pattern_key)
);

create index automation_suggestions_owner_status_idx
  on public.automation_suggestions(workspace_id, owner_user_id, status, updated_at desc);
create index automation_suggestions_workflow_idx
  on public.automation_suggestions(workflow_id) where workflow_id is not null;

-- One durable claim per reviewed workflow and source Work Item. No external action
-- occurs in this claim; the workflow can only prepare a private draft/approval.
create table public.automation_work_item_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  owner_user_id uuid not null,
  suggestion_id uuid not null references public.automation_suggestions(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  workflow_version_id uuid not null references public.workflow_versions(id) on delete cascade,
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  claim_token uuid,
  lease_until timestamptz,
  execution_id uuid references public.workflow_executions(id) on delete set null,
  failure_category text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint automation_work_item_runs_owner_fkey foreign key (workspace_id, owner_user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade,
  constraint automation_work_item_runs_once unique (workflow_id, work_item_id)
);
create index automation_work_item_runs_due_idx
  on public.automation_work_item_runs(status, lease_until, created_at);
create index automation_work_item_runs_suggestion_idx
  on public.automation_work_item_runs(suggestion_id);
create index automation_work_item_runs_version_idx
  on public.automation_work_item_runs(workflow_version_id);
create index automation_work_item_runs_execution_idx
  on public.automation_work_item_runs(execution_id) where execution_id is not null;

alter table public.automation_work_item_runs enable row level security;
alter table public.automation_work_item_runs force row level security;
revoke all on public.automation_work_item_runs from public, anon, authenticated;
grant select, insert, update, delete on public.automation_work_item_runs to service_role;
create policy automation_work_item_runs_owner_read on public.automation_work_item_runs
  for select to authenticated using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from public.workspace_memberships membership
      where membership.workspace_id = automation_work_item_runs.workspace_id
        and membership.user_id = (select auth.uid()) and membership.is_default)
  );

create function public.claim_automation_work_item_run(p_run_id uuid, p_owner_user_id uuid)
returns table (claimed boolean, claim_token uuid)
language plpgsql security invoker set search_path = '' as $$
declare v_run public.automation_work_item_runs%rowtype; v_token uuid;
begin
  if current_user <> 'service_role' or p_run_id is null or p_owner_user_id is null then
    raise exception 'Unauthorized';
  end if;
  select * into v_run from public.automation_work_item_runs r
    where r.id = p_run_id and r.owner_user_id = p_owner_user_id for update;
  if not found then raise exception 'Automation run is unavailable'; end if;
  if not exists (
    select 1 from public.automation_suggestions s
    join public.workflows w on w.id = s.workflow_id
    join public.workflow_versions v on v.id = w.published_version_id
    join public.work_items i on i.id = v_run.work_item_id
    where s.id = v_run.suggestion_id and s.status = 'active'
      and s.workspace_id = v_run.workspace_id and s.owner_user_id = v_run.owner_user_id
      and w.id = v_run.workflow_id and w.user_id = v_run.owner_user_id
      and w.workspace_id = v_run.workspace_id and w.lifecycle_state = 'active'
      and w.public_form_enabled and w.published_at is not null
      and w.published_version_id = v_run.workflow_version_id
      and v.workflow_id = w.id and v.user_id = v_run.owner_user_id
      and i.workspace_id = v_run.workspace_id and i.assignee_user_id = v_run.owner_user_id
      and i.title = s.source_title and i.source_type = s.source_type
      and i.created_at >= w.published_at
      and v.setup_config -> 'automate_this' is not null
      and (v.setup_config ->> 'automate_this')::jsonb ->> 'kind' = s.pattern_kind
      and (v.setup_config ->> 'automate_this')::jsonb ->> 'matchTitle' = i.title
      and (v.setup_config ->> 'automate_this')::jsonb ->> 'sourceType' = i.source_type
      and (
        (s.pattern_kind = 'work_item_ai_result'
          and i.status in ('needs_you', 'in_progress', 'waiting'))
        or (s.pattern_kind = 'gmail_follow_up'
          and i.status = 'waiting' and i.due_at is not null
          and i.due_at <= clock_timestamp()
          and (v.setup_config ->> 'automate_this')::jsonb ->> 'waitDays' ~ '^[0-9]{1,2}$'
          and ((v.setup_config ->> 'automate_this')::jsonb ->> 'waitDays')::integer between 1 and 30
          and i.created_at + make_interval(days => ((v.setup_config ->> 'automate_this')::jsonb ->> 'waitDays')::integer)
            <= clock_timestamp())
      )
  ) then
    return query select false, null::uuid;
    return;
  end if;
  if v_run.attempt_count >= 3 or v_run.status in ('succeeded', 'failed')
    or (v_run.status = 'running' and v_run.lease_until > clock_timestamp()) then
    return query select false, null::uuid; return;
  end if;
  v_token := gen_random_uuid();
  update public.automation_work_item_runs set status = 'running',
    claim_token = v_token, lease_until = clock_timestamp() + interval '5 minutes',
    attempt_count = attempt_count + 1, updated_at = clock_timestamp()
    where id = p_run_id;
  return query select true, v_token;
end;
$$;
revoke all on function public.claim_automation_work_item_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_automation_work_item_run(uuid, uuid) to service_role;

-- The workflow itself prepares a result. Only this transaction may turn that
-- persisted result into an exact, owner-bound Gmail approval. It never sends.
create function public.create_automation_action_approval(
  p_actor_user_id uuid, p_workflow_execution_id uuid, p_request_key text,
  p_action_title text, p_action_summary text, p_approval_reason text,
  p_connection_id uuid, p_action_snapshot jsonb
) returns setof public.action_executions
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid; v_execution public.workflow_executions%rowtype;
  v_existing public.action_executions%rowtype;
  v_item public.work_items%rowtype; v_approval public.approval_requests%rowtype;
begin
  if current_user <> 'service_role' or p_actor_user_id is null or p_workflow_execution_id is null
    or p_connection_id is null or p_request_key <> 'automation-action:' || p_workflow_execution_id::text
    or coalesce(p_action_snapshot ->> 'operationKey', '') <> 'gmail_send_email'
    or jsonb_typeof(p_action_snapshot -> 'parameters') <> 'array'
  then raise exception 'Invalid automation approval'; end if;
  select membership.workspace_id into strict v_workspace_id
    from public.workspace_memberships membership
    where membership.user_id = p_actor_user_id and membership.is_default;
  select e.* into strict v_execution from public.workflow_executions e
    join public.workflows w on w.id = e.workflow_id
    where e.id = p_workflow_execution_id and e.user_id = p_actor_user_id
      and w.user_id = p_actor_user_id and w.workspace_id = v_workspace_id
      and e.status = 'succeeded' and e.trigger_type = 'work_item';
  if not exists (select 1 from public.automation_work_item_runs r
    where r.execution_id = v_execution.id and r.owner_user_id = p_actor_user_id
      and r.workspace_id = v_workspace_id and r.workflow_id = v_execution.workflow_id)
    or not exists (select 1 from public.connector_connections c
      where c.id = p_connection_id and c.user_id = p_actor_user_id
        and c.workspace_id = v_workspace_id and c.provider_family = 'google'
        and c.status = 'connected'
        and c.granted_scopes @> array['https://www.googleapis.com/auth/gmail.send']::text[])
  then raise exception 'Automation approval source or connection is unavailable'; end if;

  select * into v_existing from public.action_executions a
    where a.workspace_id = v_workspace_id and a.idempotency_key = p_request_key;
  if found then
    if v_existing.requester_user_id <> p_actor_user_id
      or v_existing.connection_id is distinct from p_connection_id
      or v_existing.capability_id <> 'gmail_send_email'
      or not exists (select 1 from public.work_items i where i.id = v_existing.work_item_id
        and i.source_type = 'workflow_execution' and i.source_id = p_workflow_execution_id::text)
      or not exists (select 1 from public.approval_requests a
        where a.id = v_existing.approval_request_id and a.action_snapshot = p_action_snapshot)
    then raise exception 'Automation approval key belongs to another action'; end if;
    return query select * from public.action_executions where id = v_existing.id;
    return;
  end if;

  insert into public.work_items(workspace_id, assignee_user_id, title, summary,
    why_it_matters, suggested_action, status, priority, source_type,
    source_id, source_label, dedupe_key)
  values (v_workspace_id, p_actor_user_id, p_action_title, p_action_summary,
    p_approval_reason, 'Review the exact draft before sending. Nothing has been sent.',
    'needs_you', 'normal', 'workflow_execution', p_workflow_execution_id::text,
    'Automation', p_request_key)
  returning * into v_item;
  select * into strict v_approval from public.create_approval_request(
    p_actor_user_id, v_item.id, p_actor_user_id, 'workflow_execution',
    p_workflow_execution_id::text, p_request_key, p_action_title,
    p_action_summary, p_approval_reason, 'gmail_send_email', p_action_snapshot
  );
  return query insert into public.action_executions(workspace_id, requester_user_id,
    approval_request_id, work_item_id, source_message_id, connection_id,
    capability_id, connector_id, operation_key, operation_version, idempotency_key)
  values (v_workspace_id, p_actor_user_id, v_approval.id, v_item.id, null,
    p_connection_id, 'gmail_send_email', 'google_gmail', 'send_email', 1, p_request_key)
  returning *;
end;
$$;
revoke all on function public.create_automation_action_approval(uuid, uuid, text, text, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_automation_action_approval(uuid, uuid, text, text, text, text, uuid, jsonb)
  to service_role;

alter table public.automation_suggestions enable row level security;
alter table public.automation_suggestions force row level security;
revoke all on public.automation_suggestions from public, anon, authenticated;
grant select on public.automation_suggestions to authenticated;
grant select, insert, update, delete on public.automation_suggestions to service_role;
create policy automation_suggestions_owner_read on public.automation_suggestions
  for select to authenticated using (
    owner_user_id = (select auth.uid())
    and exists (select 1 from public.workspace_memberships membership
      where membership.workspace_id = automation_suggestions.workspace_id
        and membership.user_id = (select auth.uid()) and membership.is_default)
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
  'goal_plan_approved', 'goal_activated', 'goal_completed', 'goal_cancelled',
  'automation_suggested', 'automation_activated', 'automation_paused',
  'automation_disabled', 'automation_triggered', 'automation_failed'
));
alter table public.activity_events drop constraint activity_events_source_type_check;
alter table public.activity_events add constraint activity_events_source_type_check check (
  source_type in ('work_item', 'approval', 'action', 'workflow_execution', 'goal', 'automation')
);

commit;
