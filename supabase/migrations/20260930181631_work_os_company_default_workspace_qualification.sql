begin;

-- A removed active company membership leaves the account's remaining
-- membership without a default. Resolve the RETURNS TABLE output variable
-- names as statement columns so the trusted fallback can select that remaining
-- membership and make it active on the next authenticated request.
create or replace function public.ensure_default_workspace(p_user_id uuid)
returns table (workspace_id uuid, membership_role text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_workspace_id uuid;
  v_role text;
  v_default_count integer;
  v_membership_count integer;
begin
  if p_user_id is null then raise exception 'workspace bootstrap unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace-bootstrap:' || p_user_id::text, 0));

  select count(*), count(*) filter (where membership.is_default)
  into v_membership_count, v_default_count
  from public.workspace_memberships as membership
  where membership.user_id = p_user_id;

  if v_default_count > 1 then raise exception 'ambiguous default workspace'; end if;

  if v_default_count = 1 then
    select membership.workspace_id, membership.role
    into v_workspace_id, v_role
    from public.workspace_memberships as membership
    where membership.user_id = p_user_id and membership.is_default;
  elsif v_membership_count > 0 then
    select membership.workspace_id, membership.role
    into v_workspace_id, v_role
    from public.workspace_memberships as membership
    where membership.user_id = p_user_id
    order by membership.created_at, membership.workspace_id
    limit 1
    for update;

    update public.workspace_memberships as membership
    set is_default = true, updated_at = clock_timestamp()
    where membership.workspace_id = v_workspace_id and membership.user_id = p_user_id;
  else
    insert into public.workspaces(name, created_by)
    values ('My workspace', p_user_id)
    returning id into v_workspace_id;
    insert into public.workspace_memberships(workspace_id, user_id, role, is_default)
    values (v_workspace_id, p_user_id, 'owner', true);
    v_role := 'owner';
  end if;

  if v_workspace_id is null or v_role not in ('owner', 'admin', 'member') then
    raise exception 'default workspace is invalid';
  end if;
  return query select v_workspace_id, v_role;
end;
$$;

revoke all on function public.ensure_default_workspace(uuid) from public, anon, authenticated;
grant execute on function public.ensure_default_workspace(uuid) to service_role;

commit;
