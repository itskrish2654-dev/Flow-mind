begin;

-- The function returns a column named workspace_id. PL/pgSQL therefore also
-- creates an output variable with that name. Prefer table/statement columns
-- when resolving identifiers so the INSERT target column cannot collide with
-- the output variable during invitation acceptance.
create or replace function public.accept_workspace_invitation(
  p_token_hash text, p_actor_user_id uuid, p_actor_email text
)
returns table (workspace_id uuid, membership_role text, acceptance_outcome text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
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

revoke all on function public.accept_workspace_invitation(text, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_workspace_invitation(text, uuid, text) to service_role;

commit;
