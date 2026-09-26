begin;

-- Preserve privacy-safe business-object counts so this additive migration
-- fails atomically if any existing object disappears.
create temporary table workspace_foundation_pre_counts (
  workflows bigint not null,
  connector_connections bigint not null,
  workflow_executions bigint not null,
  workflow_schedules bigint not null,
  connector_subscriptions bigint not null
) on commit drop;

insert into workspace_foundation_pre_counts
select
  (select count(*) from public.workflows),
  (select count(*) from public.connector_connections),
  (select count(*) from public.workflow_executions),
  (select count(*) from public.workflow_schedules),
  (select count(*) from public.connector_subscriptions);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My workspace',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workspaces_name_length check (char_length(trim(name)) between 1 and 120)
);

create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, user_id),
  constraint workspace_memberships_role_check check (role in ('owner', 'admin', 'member'))
);

create unique index workspace_memberships_one_default_per_user
  on public.workspace_memberships(user_id)
  where is_default;

create index workspace_memberships_user_workspace_idx
  on public.workspace_memberships(user_id, workspace_id);

alter table public.workspaces enable row level security;
alter table public.workspaces force row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_memberships force row level security;

revoke all on table public.workspaces, public.workspace_memberships
  from public, anon, authenticated;
grant select on table public.workspaces, public.workspace_memberships
  to authenticated;
grant select, insert, update, delete on table public.workspaces, public.workspace_memberships
  to service_role;

create policy workspaces_member_select
  on public.workspaces
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.workspace_memberships as membership
      where membership.workspace_id = workspaces.id
        and membership.user_id = (select auth.uid())
    )
  );

-- Membership mutation is service-controlled in this foundation. A signed-in
-- user may inspect only their own membership record, not another company's
-- membership directory.
create policy workspace_memberships_self_select
  on public.workspace_memberships
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
  );

-- Idempotent, server-only lazy bootstrap. This remains SECURITY INVOKER: the
-- service role has the required grants and browser roles cannot execute it.
create function public.ensure_default_workspace(p_user_id uuid)
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
  if p_user_id is null then
    raise exception 'workspace bootstrap unavailable';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('workspace-bootstrap:' || p_user_id::text, 0)
  );

  select count(*), count(*) filter (where membership.is_default)
  into v_membership_count, v_default_count
  from public.workspace_memberships as membership
  where membership.user_id = p_user_id;

  if v_default_count > 1 then
    raise exception 'ambiguous default workspace';
  end if;

  if v_default_count = 0 and v_membership_count > 0 then
    raise exception 'default workspace is missing';
  end if;

  if v_default_count = 1 then
    select membership.workspace_id, membership.role
    into v_workspace_id, v_role
    from public.workspace_memberships as membership
    where membership.user_id = p_user_id
      and membership.is_default;
  end if;

  if v_default_count = 0 then
    insert into public.workspaces(name, created_by)
    values ('My workspace', p_user_id)
    returning id into v_workspace_id;

    insert into public.workspace_memberships(
      workspace_id, user_id, role, is_default
    ) values (
      v_workspace_id, p_user_id, 'owner', true
    );
    v_role := 'owner';
  end if;

  if v_workspace_id is null
     or v_role not in ('owner', 'admin', 'member')
     or not exists (
       select 1
       from public.workspaces as workspace
       where workspace.id = v_workspace_id
     ) then
    raise exception 'default workspace is invalid';
  end if;

  return query select v_workspace_id, v_role;
end;
$$;

revoke all on function public.ensure_default_workspace(uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_default_workspace(uuid)
  to service_role;

-- Backfill every Auth account, including accounts without current business
-- objects. Advisory locking plus the partial unique index makes replay safe.
do $bootstrap$
declare
  account record;
begin
  for account in select id from auth.users order by id
  loop
    perform * from public.ensure_default_workspace(account.id);
  end loop;
end
$bootstrap$;

alter table public.workflows add column workspace_id uuid;
alter table public.connector_connections add column workspace_id uuid;

update public.workflows as workflow
set workspace_id = membership.workspace_id
from public.workspace_memberships as membership
where membership.user_id = workflow.user_id
  and membership.is_default;

update public.connector_connections as connection
set workspace_id = membership.workspace_id
from public.workspace_memberships as membership
where membership.user_id = connection.user_id
  and membership.is_default;

do $ownership_backfill$
begin
  if exists (select 1 from public.workflows where user_id is null) then
    raise exception 'workspace backfill found an ownerless workflow';
  end if;
  if exists (select 1 from public.workflows where workspace_id is null) then
    raise exception 'workspace backfill failed for workflows';
  end if;
  if exists (select 1 from public.connector_connections where workspace_id is null) then
    raise exception 'workspace backfill failed for connector connections';
  end if;
end
$ownership_backfill$;

alter table public.workflows
  alter column user_id set not null,
  alter column workspace_id set not null;
alter table public.connector_connections
  alter column workspace_id set not null;

alter table public.workflows
  add constraint workflows_workspace_membership_fkey
  foreign key (workspace_id, user_id)
  references public.workspace_memberships(workspace_id, user_id)
  on delete restrict;

alter table public.connector_connections
  add constraint connector_connections_workspace_membership_fkey
  foreign key (workspace_id, user_id)
  references public.workspace_memberships(workspace_id, user_id)
  on delete restrict;

create index workflows_workspace_owner_idx
  on public.workflows(workspace_id, user_id);
create index connector_connections_workspace_owner_idx
  on public.connector_connections(workspace_id, user_id, status);

-- Root rows may never accept browser-selected workspace tenancy. Every insert
-- derives the user's trusted default workspace, and attempts to supply another
-- workspace fail closed. The same boundary prevents later ownership moves.
create function public.enforce_default_workspace_ownership()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_default_count integer;
begin
  if new.user_id is null then
    raise exception 'resource owner is required';
  end if;

  select count(*)
  into v_default_count
  from public.workspace_memberships as membership
  where membership.user_id = new.user_id
    and membership.is_default;

  if v_default_count <> 1 then
    raise exception 'trusted default workspace is unavailable';
  end if;

  select membership.workspace_id
  into v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = new.user_id
    and membership.is_default;

  if v_workspace_id is null then
    raise exception 'trusted default workspace is unavailable';
  end if;

  if new.workspace_id is not null and new.workspace_id <> v_workspace_id then
    raise exception 'workspace ownership mismatch';
  end if;

  new.workspace_id := v_workspace_id;
  return new;
end;
$$;

revoke all on function public.enforce_default_workspace_ownership()
  from public, anon, authenticated;
grant execute on function public.enforce_default_workspace_ownership()
  to service_role;

create trigger workflows_default_workspace_ownership
before insert or update of user_id, workspace_id
on public.workflows
for each row execute function public.enforce_default_workspace_ownership();

create trigger connector_connections_default_workspace_ownership
before insert or update of user_id, workspace_id
on public.connector_connections
for each row execute function public.enforce_default_workspace_ownership();

-- Preserve user ownership and additionally require that the root belongs to
-- the caller's trusted default workspace. Authenticated workflow writes remain
-- revoked; the policies also protect projects where grants differ.
drop policy if exists "Users can only view their own workflows" on public.workflows;
drop policy if exists "Users can only insert their own workflows" on public.workflows;
drop policy if exists "Users can only update their own workflows" on public.workflows;
drop policy if exists "Users can only delete their own workflows" on public.workflows;

create policy "Users can only view their own workflows"
  on public.workflows for select to authenticated
  using (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = workflows.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

create policy "Users can only insert their own workflows"
  on public.workflows for insert to authenticated
  with check (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = workflows.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

create policy "Users can only update their own workflows"
  on public.workflows for update to authenticated
  using (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = workflows.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  )
  with check (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = workflows.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

create policy "Users can only delete their own workflows"
  on public.workflows for delete to authenticated
  using (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = workflows.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

drop policy if exists connector_connections_owner_select
  on public.connector_connections;
create policy connector_connections_owner_select
  on public.connector_connections
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = connector_connections.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

-- Explicit grants account for the 2026 Supabase Data API default change.
-- Browser roles receive read-only access protected by RLS; membership and root
-- mutations remain service-controlled.
revoke insert, update, delete on table public.workflows from authenticated;
revoke all on table public.connector_connections from anon, authenticated;
grant select on table public.connector_connections to authenticated;
grant select, insert, update, delete on table public.workflows, public.connector_connections
  to service_role;

-- Extend account cleanup without changing current private-account semantics.
-- Shared workspaces, if introduced later, survive while another membership or
-- resource remains; only empty workspaces created by the deleted user are removed.
create or replace function public.cleanup_account_data(p_job_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_owner uuid;
begin
  if p_job_id is null or p_user_id is null then
    raise exception 'invalid account cleanup request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('account-delete:' || p_user_id::text, 0));
  select user_id into job_owner
  from public.account_deletion_jobs
  where id = p_job_id
    and state in ('requested', 'processing', 'failed')
  for update;

  if job_owner is null or job_owner <> p_user_id then
    raise exception 'account deletion job not found';
  end if;

  update public.account_deletion_jobs
  set state = 'processing',
      started_at = coalesce(started_at, clock_timestamp()),
      updated_at = clock_timestamp(),
      retry_count = retry_count + 1,
      failure_code = null
  where id = p_job_id;

  update public.workflows
  set public_form_enabled = false,
      published_at = null,
      lifecycle_state = 'disabled',
      current_version_id = null,
      published_version_id = null,
      updated_at = clock_timestamp()
  where user_id = p_user_id;

  delete from public.workflow_execution_steps
  where execution_id in (
    select id from public.workflow_executions where user_id = p_user_id
  );
  delete from public.workflow_executions where user_id = p_user_id;
  delete from public.workflow_credentials where user_id = p_user_id;
  delete from public.generated_document_records where user_id = p_user_id;
  delete from public.usage_counters where user_id = p_user_id;
  delete from public.workflow_versions where user_id = p_user_id;
  delete from public.workflows where user_id = p_user_id;

  delete from public.workspace_memberships where user_id = p_user_id;
  delete from public.workspaces as workspace
  where workspace.created_by = p_user_id
    and not exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = workspace.id
    )
    and not exists (
      select 1 from public.workflows as workflow
      where workflow.workspace_id = workspace.id
    )
    and not exists (
      select 1 from public.connector_connections as connection
      where connection.workspace_id = workspace.id
    );

  update public.account_deletion_jobs
  set updated_at = clock_timestamp()
  where id = p_job_id;

  return true;
end;
$$;
revoke all on function public.cleanup_account_data(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cleanup_account_data(uuid, uuid)
  to service_role;

-- Validate the backfill and prove the migration did not delete business data.
do $invariants$
declare
  expected record;
begin
  select * into expected from workspace_foundation_pre_counts;

  if expected.workflows <> (select count(*) from public.workflows)
     or expected.connector_connections <> (select count(*) from public.connector_connections)
     or expected.workflow_executions <> (select count(*) from public.workflow_executions)
     or expected.workflow_schedules <> (select count(*) from public.workflow_schedules)
     or expected.connector_subscriptions <> (select count(*) from public.connector_subscriptions) then
    raise exception 'workspace migration changed existing business-object counts';
  end if;

  if exists (
    select account.id
    from auth.users as account
    left join public.workspace_memberships as membership
      on membership.user_id = account.id and membership.is_default
    group by account.id
    having count(membership.workspace_id) <> 1
  ) then
    raise exception 'every account must have exactly one default workspace';
  end if;

  if exists (
    select 1
    from public.workspace_memberships
    where is_default and role <> 'owner'
  ) then
    raise exception 'migrated default workspace membership must be owner';
  end if;

  if exists (
    select 1
    from public.workflows as workflow
    join public.workspace_memberships as membership
      on membership.workspace_id = workflow.workspace_id
     and membership.user_id = workflow.user_id
    where not membership.is_default
  ) or exists (
    select 1
    from public.connector_connections as connection
    join public.workspace_memberships as membership
      on membership.workspace_id = connection.workspace_id
     and membership.user_id = connection.user_id
    where not membership.is_default
  ) then
    raise exception 'root resource is not attached to the trusted default workspace';
  end if;
end
$invariants$;

commit;
