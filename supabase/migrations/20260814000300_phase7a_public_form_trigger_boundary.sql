begin;

-- Connector publication reuses the workflow publication flag, but it must not
-- make a webhook-trigger workflow reachable through the hosted-form route.
drop function if exists public.get_public_workflow(uuid);
create function public.get_public_workflow(p_workflow_id uuid)
returns table (
  id uuid, name text, workflow_name text, summary text,
  public_form jsonb, challenge_mode text
)
language sql stable security definer set search_path = ''
as $$
  select workflow.id, workflow.name,
    coalesce(version.compiled_workflow ->> 'workflowName', workflow.name),
    coalesce(version.compiled_workflow ->> 'summary', 'Submit information to this FlowMind automation.'),
    version.compiled_workflow -> 'publicForm', workflow.public_form_challenge_mode
  from public.workflows as workflow
  join public.workflow_versions as version on version.id = workflow.current_version_id
  where workflow.id = p_workflow_id
    and workflow.public_form_enabled
    and workflow.lifecycle_state = 'active'
    and version.compiled_workflow ? 'publicForm'
    and jsonb_typeof(version.compiled_workflow -> 'publicForm') = 'object'
  limit 1;
$$;
revoke all on function public.get_public_workflow(uuid) from public;
grant execute on function public.get_public_workflow(uuid) to anon, authenticated;

commit;
