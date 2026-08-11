begin;

-- Workflow capacity is an active-resource limit, so the workflows table is
-- authoritative. The per-owner advisory lock makes the count and insert one
-- transaction across every application instance.
create or replace function public.create_workflow_with_quota(
  p_user_id uuid,
  p_name text,
  p_prompt text,
  p_compiled_steps jsonb,
  p_limit integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workflow_count bigint;
  v_workflow_id uuid;
begin
  if p_limit < 1 or p_limit > 100000 then
    raise exception 'invalid workflow limit';
  end if;
  if p_user_id is null
    or char_length(p_name) < 1
    or char_length(p_name) > 80
    or char_length(p_prompt) < 1
    or char_length(p_prompt) > 10000
    or jsonb_typeof(p_compiled_steps) <> 'object'
  then
    raise exception 'invalid workflow values';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('workflow-quota:' || p_user_id::text, 0)
  );

  select count(*) into v_workflow_count
  from public.workflows
  where user_id = p_user_id;

  if v_workflow_count >= p_limit then
    return null;
  end if;

  insert into public.workflows (
    user_id,
    name,
    prompt,
    compiled_steps,
    public_form_enabled,
    published_at
  ) values (
    p_user_id,
    p_name,
    p_prompt,
    p_compiled_steps,
    false,
    null
  )
  returning id into v_workflow_id;

  return v_workflow_id;
end;
$$;

revoke all on function public.create_workflow_with_quota(
  uuid,
  text,
  text,
  jsonb,
  integer
) from public, anon, authenticated;
grant execute on function public.create_workflow_with_quota(
  uuid,
  text,
  text,
  jsonb,
  integer
) to service_role;

commit;
