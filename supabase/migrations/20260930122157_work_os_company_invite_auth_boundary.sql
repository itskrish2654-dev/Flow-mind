begin;

-- Auth-account email lookup belongs to the server Auth Admin API. The database
-- service role intentionally has no direct SELECT authority over auth.users.
create or replace function public.create_workspace_invitation(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_invited_email text,
  p_intended_role text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns setof public.workspace_invitations
language plpgsql
security invoker
set search_path = ''
as $$
declare v_actor_role text; v_email text := lower(trim(p_invited_email)); v_invite public.workspace_invitations%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'invitation unavailable'; end if;
  if p_intended_role not in ('admin', 'member') or p_token_hash !~ '^[0-9a-f]{64}$'
     or char_length(v_email) not between 3 and 320
     or p_expires_at <= clock_timestamp() then raise exception 'invitation is invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended('workspace-invite:' || p_workspace_id::text || ':' || v_email, 0));
  select membership.role into v_actor_role
  from public.workspace_memberships as membership
  where membership.workspace_id = p_workspace_id and membership.user_id = p_actor_user_id;
  if v_actor_role = 'admin' and p_intended_role <> 'member' then raise exception 'invitation unavailable'; end if;
  if v_actor_role not in ('owner', 'admin') then raise exception 'invitation unavailable'; end if;

  update public.workspace_invitations as invitation
  set status = 'expired', updated_at = clock_timestamp()
  where invitation.workspace_id = p_workspace_id and invitation.normalized_email = v_email
    and invitation.status = 'pending' and invitation.expires_at <= clock_timestamp();
  update public.workspace_invitations as invitation
  set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_actor_user_id,
      updated_at = clock_timestamp()
  where invitation.workspace_id = p_workspace_id and invitation.normalized_email = v_email
    and invitation.status = 'pending';

  insert into public.workspace_invitations(
    workspace_id, invited_email, normalized_email, intended_role, token_hash,
    created_by, expires_at
  ) values (
    p_workspace_id, trim(p_invited_email), v_email, p_intended_role, p_token_hash,
    p_actor_user_id, p_expires_at
  ) returning * into v_invite;
  return next v_invite;
end;
$$;

revoke all on function public.create_workspace_invitation(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_workspace_invitation(uuid, uuid, text, text, text, timestamptz)
  to service_role;

commit;
