begin;

drop function if exists public.get_public_workflow(uuid);

create function public.get_public_workflow(p_workflow_id uuid)
returns table (
  id uuid,
  name text,
  workflow_name text,
  summary text,
  public_form jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    workflow.id,
    workflow.name,
    coalesce(workflow.compiled_steps ->> 'workflowName', workflow.name),
    coalesce(
      workflow.compiled_steps ->> 'summary',
      'Submit information to this FlowMind automation.'
    ),
    workflow.compiled_steps -> 'publicForm'
  from public.workflows as workflow
  where workflow.id = p_workflow_id
    and workflow.public_form_enabled
    and workflow.compiled_steps is not null
  limit 1;
$$;

revoke all on function public.get_public_workflow(uuid) from public;
grant execute on function public.get_public_workflow(uuid) to anon, authenticated;

commit;
