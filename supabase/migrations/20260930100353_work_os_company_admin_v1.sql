begin;

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invited_email text not null,
  normalized_email text not null,
  intended_role text not null,
  status text not null default 'pending',
  token_hash text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  constraint workspace_invitations_email_normalized check (
    normalized_email = lower(trim(invited_email))
    and char_length(normalized_email) between 3 and 320
  ),
  constraint workspace_invitations_role_check check (intended_role in ('admin', 'member')),
  constraint workspace_invitations_status_check check (status in ('pending', 'accepted', 'revoked', 'expired')),
  constraint workspace_invitations_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint workspace_invitations_expiry_check check (expires_at > created_at),
  constraint workspace_invitations_terminal_state_check check (
    (status = 'pending' and accepted_at is null and revoked_at is null and accepted_by is null and revoked_by is null)
    or (status = 'accepted' and accepted_at is not null and accepted_by is not null and revoked_at is null and revoked_by is null)
    or (status = 'revoked' and revoked_at is not null and accepted_at is null and accepted_by is null)
    or (status = 'expired' and accepted_at is null and accepted_by is null and revoked_at is null and revoked_by is null)
  )
);

create unique index workspace_invitations_one_pending_per_email
  on public.workspace_invitations(workspace_id, normalized_email)
  where status = 'pending';
create index workspace_invitations_workspace_status_idx
  on public.workspace_invitations(workspace_id, status, created_at desc);
create index workspace_invitations_expiry_idx
  on public.workspace_invitations(expires_at)
  where status = 'pending';

alter table public.workspace_invitations enable row level security;
alter table public.workspace_invitations force row level security;
revoke all on table public.workspace_invitations from public, anon, authenticated;
grant select, insert, update, delete on table public.workspace_invitations to service_role;

-- If a selected membership was removed, choose another real membership on the
-- next trusted request. If none remains, preserve the existing personal
-- workspace bootstrap behavior.
create or replace function public.ensure_default_workspace(p_user_id uuid)
returns table (workspace_id uuid, membership_role text)
language plpgsql
security invoker
set search_path = ''
as $$
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

    update public.workspace_memberships
    set is_default = true, updated_at = clock_timestamp()
    where workspace_id = v_workspace_id and user_id = p_user_id;
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

create function public.switch_active_workspace(p_actor_user_id uuid, p_workspace_id uuid)
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
  select role into v_role from public.workspace_memberships
  where workspace_id = p_workspace_id and user_id = p_actor_user_id for update;
  if v_role is null then raise exception 'workspace membership unavailable'; end if;
  update public.workspace_memberships set is_default = false, updated_at = clock_timestamp()
  where user_id = p_actor_user_id and is_default;
  update public.workspace_memberships set is_default = true, updated_at = clock_timestamp()
  where workspace_id = p_workspace_id and user_id = p_actor_user_id;
  return query select p_workspace_id, v_role;
end;
$$;

create function public.rename_company_workspace(
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
  select role into v_actor_role from public.workspace_memberships
  where workspace_id = p_workspace_id and user_id = p_actor_user_id;
  if v_actor_role not in ('owner', 'admin') then raise exception 'workspace update unavailable'; end if;
  update public.workspaces set name = v_name, updated_at = clock_timestamp()
  where id = p_workspace_id;
  if not found then raise exception 'workspace update unavailable'; end if;
  return query select p_workspace_id, v_name;
end;
$$;

create function public.create_workspace_invitation(
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
  select role into v_actor_role from public.workspace_memberships
  where workspace_id = p_workspace_id and user_id = p_actor_user_id;
  if v_actor_role = 'admin' and p_intended_role <> 'member' then raise exception 'invitation unavailable'; end if;
  if v_actor_role not in ('owner', 'admin') then raise exception 'invitation unavailable'; end if;

  if exists (
    select 1 from public.workspace_memberships m
    join auth.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id and lower(trim(u.email)) = v_email
  ) then raise exception 'account is already a member'; end if;

  update public.workspace_invitations
  set status = 'expired', updated_at = clock_timestamp()
  where workspace_id = p_workspace_id and normalized_email = v_email
    and status = 'pending' and expires_at <= clock_timestamp();
  update public.workspace_invitations
  set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_actor_user_id,
      updated_at = clock_timestamp()
  where workspace_id = p_workspace_id and normalized_email = v_email and status = 'pending';

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

create function public.revoke_workspace_invitation(
  p_invitation_id uuid, p_actor_user_id uuid
)
returns setof public.workspace_invitations
language plpgsql
security invoker
set search_path = ''
as $$
declare v_invite public.workspace_invitations%rowtype; v_actor_role text;
begin
  if current_user <> 'service_role' then raise exception 'invitation unavailable'; end if;
  select * into v_invite from public.workspace_invitations where id = p_invitation_id for update;
  if v_invite.id is null then raise exception 'invitation unavailable'; end if;
  select role into v_actor_role from public.workspace_memberships
  where workspace_id = v_invite.workspace_id and user_id = p_actor_user_id;
  if v_actor_role = 'admin' and v_invite.intended_role <> 'member' then raise exception 'invitation unavailable'; end if;
  if v_actor_role not in ('owner', 'admin') then raise exception 'invitation unavailable'; end if;
  if v_invite.status <> 'pending' then raise exception 'invitation is no longer pending'; end if;
  update public.workspace_invitations
  set status = 'revoked', revoked_at = clock_timestamp(), revoked_by = p_actor_user_id,
      updated_at = clock_timestamp()
  where id = p_invitation_id returning * into v_invite;
  return next v_invite;
end;
$$;

create function public.accept_workspace_invitation(
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
  select * into v_invite from public.workspace_invitations where token_hash = p_token_hash for update;
  if v_invite.id is null then raise exception 'invitation unavailable'; end if;

  if v_invite.status = 'accepted' then
    if v_invite.accepted_by <> p_actor_user_id or v_invite.normalized_email <> v_email then raise exception 'invitation unavailable'; end if;
    select role into v_role from public.workspace_memberships
    where workspace_id = v_invite.workspace_id and user_id = p_actor_user_id;
    if v_role is null then raise exception 'invitation membership unavailable'; end if;
    perform * from public.switch_active_workspace(p_actor_user_id, v_invite.workspace_id);
    return query select v_invite.workspace_id, v_role, 'already_accepted'::text;
    return;
  end if;
  if v_invite.status <> 'pending' then raise exception 'invitation unavailable'; end if;
  if v_invite.expires_at <= clock_timestamp() then
    update public.workspace_invitations set status = 'expired', updated_at = clock_timestamp() where id = v_invite.id;
    return query select null::uuid, null::text, 'expired'::text;
    return;
  end if;
  if v_invite.normalized_email <> v_email then raise exception 'invitation account mismatch'; end if;

  insert into public.workspace_memberships(workspace_id, user_id, role, is_default)
  values (v_invite.workspace_id, p_actor_user_id, v_invite.intended_role, false)
  on conflict (workspace_id, user_id) do nothing;
  select role into v_role from public.workspace_memberships
  where workspace_id = v_invite.workspace_id and user_id = p_actor_user_id;
  if v_role is null then raise exception 'invitation membership unavailable'; end if;
  update public.workspace_invitations
  set status = 'accepted', accepted_at = clock_timestamp(), accepted_by = p_actor_user_id,
      updated_at = clock_timestamp()
  where id = v_invite.id and status = 'pending';
  if not found then raise exception 'invitation unavailable'; end if;
  perform * from public.switch_active_workspace(p_actor_user_id, v_invite.workspace_id);
  return query select v_invite.workspace_id, v_role, 'accepted'::text;
end;
$$;

create function public.administer_workspace_member(
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
  select role into v_actor_role from public.workspace_memberships
  where workspace_id = p_workspace_id and user_id = p_actor_user_id for update;
  select role into v_target_role from public.workspace_memberships
  where workspace_id = p_workspace_id and user_id = p_target_user_id for update;
  if v_actor_role not in ('owner', 'admin') or v_target_role is null or v_target_role = 'owner' then
    raise exception 'member administration unavailable';
  end if;
  if v_actor_role = 'admin' and v_target_role <> 'member' then raise exception 'member administration unavailable'; end if;

  if p_action = 'change_role' then
    if v_actor_role <> 'owner' or p_role not in ('admin', 'member') then raise exception 'member administration unavailable'; end if;
    update public.workspace_memberships set role = p_role, updated_at = clock_timestamp()
    where workspace_id = p_workspace_id and user_id = p_target_user_id;
    return query select p_workspace_id, p_target_user_id, p_role, 'role_changed'::text;
  elsif p_action = 'remove' then
    -- User-owned roots cannot outlive their membership under the existing
    -- composite foreign keys. Removing a member therefore removes only that
    -- user's roots in this workspace; cascades clean their dependent data.
    delete from public.workflows where workspace_id = p_workspace_id and user_id = p_target_user_id;
    delete from public.connector_connections where workspace_id = p_workspace_id and user_id = p_target_user_id;
    delete from public.workspace_memberships where workspace_id = p_workspace_id and user_id = p_target_user_id;
    return query select p_workspace_id, p_target_user_id, v_target_role, 'removed'::text;
  else
    raise exception 'member administration unavailable';
  end if;
end;
$$;

revoke all on function public.switch_active_workspace(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rename_company_workspace(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.create_workspace_invitation(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.revoke_workspace_invitation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.accept_workspace_invitation(text, uuid, text) from public, anon, authenticated;
revoke all on function public.administer_workspace_member(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.switch_active_workspace(uuid, uuid) to service_role;
grant execute on function public.rename_company_workspace(uuid, uuid, text) to service_role;
grant execute on function public.create_workspace_invitation(uuid, uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.revoke_workspace_invitation(uuid, uuid) to service_role;
grant execute on function public.accept_workspace_invitation(text, uuid, text) to service_role;
grant execute on function public.administer_workspace_member(uuid, uuid, uuid, text, text) to service_role;

commit;
