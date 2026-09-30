begin;

-- PL/pgSQL output-column names are variables. Qualify every table column in
-- functions whose return names overlap membership columns so valid service
-- calls cannot fail with 42702 ambiguity.
create or replace function public.switch_active_workspace(p_actor_user_id uuid, p_workspace_id uuid)
returns table (workspace_id uuid, membership_role text)
language plpgsql
security invoker
set search_path = ''
as $$
declare v_role text;
begin
  if current_user <> 'service_role' then raise exception 'workspace switch unavailable'; end if;
  if p_actor_user_id is null or p_workspace_id is null then raise exception 'workspace switch unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace-switch:' || p_actor_user_id::text, 0));
  select membership.role into v_role
  from public.workspace_memberships as membership
  where membership.workspace_id = p_workspace_id and membership.user_id = p_actor_user_id
  for update;
  if v_role is null then raise exception 'workspace membership unavailable'; end if;
  update public.workspace_memberships as membership
  set is_default = false, updated_at = clock_timestamp()
  where membership.user_id = p_actor_user_id and membership.is_default;
  update public.workspace_memberships as membership
  set is_default = true, updated_at = clock_timestamp()
  where membership.workspace_id = p_workspace_id and membership.user_id = p_actor_user_id;
  return query select p_workspace_id, v_role;
end;
$$;

create or replace function public.rename_company_workspace(
  p_workspace_id uuid, p_actor_user_id uuid, p_name text
)
returns table (workspace_id uuid, workspace_name text)
language plpgsql
security invoker
set search_path = ''
as $$
declare v_actor_role text; v_name text := trim(p_name);
begin
  if current_user <> 'service_role' then raise exception 'workspace update unavailable'; end if;
  if char_length(v_name) not between 1 and 120 then raise exception 'workspace name is invalid'; end if;
  select membership.role into v_actor_role
  from public.workspace_memberships as membership
  where membership.workspace_id = p_workspace_id and membership.user_id = p_actor_user_id;
  if v_actor_role not in ('owner', 'admin') then raise exception 'workspace update unavailable'; end if;
  update public.workspaces as workspace
  set name = v_name, updated_at = clock_timestamp()
  where workspace.id = p_workspace_id;
  if not found then raise exception 'workspace update unavailable'; end if;
  return query select p_workspace_id, v_name;
end;
$$;

create or replace function public.accept_workspace_invitation(
  p_token_hash text, p_actor_user_id uuid, p_actor_email text
)
returns table (workspace_id uuid, membership_role text, acceptance_outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare v_invite public.workspace_invitations%rowtype; v_email text := lower(trim(p_actor_email)); v_role text;
begin
  if current_user <> 'service_role' then raise exception 'invitation unavailable'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_actor_user_id is null or char_length(v_email) not between 3 and 320 then
    raise exception 'invitation unavailable';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace-invite-token:' || p_token_hash, 0));
  select invitation.* into v_invite
  from public.workspace_invitations as invitation
  where invitation.token_hash = p_token_hash
  for update;
  if v_invite.id is null then raise exception 'invitation unavailable'; end if;

  if v_invite.status = 'accepted' then
    if v_invite.accepted_by <> p_actor_user_id or v_invite.normalized_email <> v_email then raise exception 'invitation unavailable'; end if;
    select membership.role into v_role
    from public.workspace_memberships as membership
    where membership.workspace_id = v_invite.workspace_id and membership.user_id = p_actor_user_id;
    if v_role is null then raise exception 'invitation membership unavailable'; end if;
    perform * from public.switch_active_workspace(p_actor_user_id, v_invite.workspace_id);
    return query select v_invite.workspace_id, v_role, 'already_accepted'::text;
    return;
  end if;
  if v_invite.status <> 'pending' then raise exception 'invitation unavailable'; end if;
  if v_invite.expires_at <= clock_timestamp() then
    update public.workspace_invitations as invitation
    set status = 'expired', updated_at = clock_timestamp()
    where invitation.id = v_invite.id;
    return query select null::uuid, null::text, 'expired'::text;
    return;
  end if;
  if v_invite.normalized_email <> v_email then raise exception 'invitation account mismatch'; end if;

  insert into public.workspace_memberships(workspace_id, user_id, role, is_default)
  values (v_invite.workspace_id, p_actor_user_id, v_invite.intended_role, false)
  on conflict (workspace_id, user_id) do nothing;
  select membership.role into v_role
  from public.workspace_memberships as membership
  where membership.workspace_id = v_invite.workspace_id and membership.user_id = p_actor_user_id;
  if v_role is null then raise exception 'invitation membership unavailable'; end if;
  update public.workspace_invitations as invitation
  set status = 'accepted', accepted_at = clock_timestamp(), accepted_by = p_actor_user_id,
      updated_at = clock_timestamp()
  where invitation.id = v_invite.id and invitation.status = 'pending';
  if not found then raise exception 'invitation unavailable'; end if;
  perform * from public.switch_active_workspace(p_actor_user_id, v_invite.workspace_id);
  return query select v_invite.workspace_id, v_role, 'accepted'::text;
end;
$$;

create or replace function public.administer_workspace_member(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_action text,
  p_role text default null
)
returns table (workspace_id uuid, user_id uuid, membership_role text, outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
declare v_actor_role text; v_target_role text;
begin
  if current_user <> 'service_role' then raise exception 'member administration unavailable'; end if;
  if p_actor_user_id = p_target_user_id then raise exception 'member administration unavailable'; end if;
  select membership.role into v_actor_role
  from public.workspace_memberships as membership
  where membership.workspace_id = p_workspace_id and membership.user_id = p_actor_user_id
  for update;
  select membership.role into v_target_role
  from public.workspace_memberships as membership
  where membership.workspace_id = p_workspace_id and membership.user_id = p_target_user_id
  for update;
  if v_actor_role not in ('owner', 'admin') or v_target_role is null or v_target_role = 'owner' then
    raise exception 'member administration unavailable';
  end if;
  if v_actor_role = 'admin' and v_target_role <> 'member' then raise exception 'member administration unavailable'; end if;

  if p_action = 'change_role' then
    if v_actor_role <> 'owner' or p_role not in ('admin', 'member') then raise exception 'member administration unavailable'; end if;
    update public.workspace_memberships as membership
    set role = p_role, updated_at = clock_timestamp()
    where membership.workspace_id = p_workspace_id and membership.user_id = p_target_user_id;
    return query select p_workspace_id, p_target_user_id, p_role, 'role_changed'::text;
  elsif p_action = 'remove' then
    delete from public.workflows as workflow
    where workflow.workspace_id = p_workspace_id and workflow.user_id = p_target_user_id;
    delete from public.connector_connections as connection
    where connection.workspace_id = p_workspace_id and connection.user_id = p_target_user_id;
    delete from public.workspace_memberships as membership
    where membership.workspace_id = p_workspace_id and membership.user_id = p_target_user_id;
    return query select p_workspace_id, p_target_user_id, v_target_role, 'removed'::text;
  else
    raise exception 'member administration unavailable';
  end if;
end;
$$;

revoke all on function public.switch_active_workspace(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rename_company_workspace(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.accept_workspace_invitation(text, uuid, text) from public, anon, authenticated;
revoke all on function public.administer_workspace_member(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.switch_active_workspace(uuid, uuid) to service_role;
grant execute on function public.rename_company_workspace(uuid, uuid, text) to service_role;
grant execute on function public.accept_workspace_invitation(text, uuid, text) to service_role;
grant execute on function public.administer_workspace_member(uuid, uuid, uuid, text, text) to service_role;

commit;
