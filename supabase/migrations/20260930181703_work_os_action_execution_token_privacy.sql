begin;

update public.action_executions
set claim_token = null
where status <> 'executing' and claim_token is not null;

alter table public.action_executions
  drop constraint action_executions_claim_check,
  add constraint action_executions_claim_check check (
    (status = 'executing' and claim_token is not null and claimed_at is not null)
    or (status <> 'executing' and claim_token is null)
  );

revoke select on table public.action_executions from authenticated;
grant select (
  id, workspace_id, requester_user_id, approval_request_id, work_item_id,
  source_message_id, connection_id, capability_id, connector_id, operation_key,
  operation_version, status, claimed_at, attempt_count, acknowledged,
  externally_delivered, provider_reference_id, result_summary, failure_category,
  failure_message, created_at, updated_at, completed_at
) on table public.action_executions to authenticated;

create or replace function public.complete_action_execution(
  p_execution_id uuid, p_claim_token uuid, p_status text,
  p_acknowledged boolean, p_externally_delivered boolean,
  p_provider_reference_id text, p_result_summary text,
  p_failure_category text, p_failure_message text
) returns setof public.action_executions
language plpgsql security invoker set search_path = '' as $$
declare
  v_action public.action_executions%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_status not in ('succeeded', 'failed', 'ambiguous') then raise exception 'Invalid action result'; end if;
  select * into strict v_action from public.action_executions
    where id = p_execution_id and status = 'executing' and claim_token = p_claim_token for update;
  if p_status = 'succeeded' and (not p_acknowledged or not p_externally_delivered or p_failure_category is not null)
    then raise exception 'Success requires provider acknowledgement'; end if;
  if p_status <> 'succeeded' and (p_externally_delivered or p_failure_category is null)
    then raise exception 'Failure result is inconsistent'; end if;
  update public.action_executions set status = p_status, claim_token = null,
    acknowledged = p_acknowledged, externally_delivered = p_externally_delivered,
    provider_reference_id = p_provider_reference_id, result_summary = p_result_summary,
    failure_category = p_failure_category, failure_message = p_failure_message,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_action.id;
  update public.work_items set status = case when p_status = 'succeeded' then 'handled' else 'needs_you' end,
    summary = coalesce(p_result_summary, summary),
    suggested_action = case when p_status = 'succeeded' then suggested_action else 'Review the action outcome before trying again.' end,
    resolved_at = case when p_status = 'succeeded' then clock_timestamp() else null end,
    updated_at = clock_timestamp()
  where id = v_action.work_item_id and status = 'waiting';
  return query select * from public.action_executions where id = v_action.id;
end;
$$;

commit;
