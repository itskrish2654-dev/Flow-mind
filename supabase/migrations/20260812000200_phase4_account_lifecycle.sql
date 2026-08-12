begin;

-- A deletion job survives deletion of the Auth identity so operators can
-- distinguish a completed request from an interrupted one. The table is
-- deliberately service-role only and does not expose failure details to users.
create table if not exists public.account_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  state text not null default 'requested',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  retry_count integer not null default 0,
  failure_code text,
  constraint account_deletion_jobs_state_check
    check (state in ('requested', 'processing', 'completed', 'failed')),
  constraint account_deletion_jobs_retry_check check (retry_count between 0 and 20)
);

create index if not exists account_deletion_jobs_user_requested_idx
  on public.account_deletion_jobs(user_id, requested_at desc);

alter table public.account_deletion_jobs enable row level security;
alter table public.account_deletion_jobs force row level security;
revoke all on table public.account_deletion_jobs from public, anon, authenticated;
grant all on table public.account_deletion_jobs to service_role;

-- Public access is revoked in the same transaction that records the request.
create or replace function public.request_account_deletion(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_id uuid;
begin
  if p_user_id is null then
    raise exception 'invalid account deletion request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('account-delete:' || p_user_id::text, 0));

  update public.workflows
  set public_form_enabled = false,
      published_at = null,
      lifecycle_state = 'disabled',
      updated_at = clock_timestamp()
  where user_id = p_user_id;

  select id into job_id
  from public.account_deletion_jobs
  where user_id = p_user_id
    and state in ('requested', 'processing', 'failed')
  order by requested_at desc
  limit 1
  for update;

  if job_id is null then
    insert into public.account_deletion_jobs(user_id)
    values (p_user_id)
    returning id into job_id;
  else
    update public.account_deletion_jobs
    set state = 'requested',
        updated_at = clock_timestamp(),
        failure_code = null
    where id = job_id;
  end if;

  return job_id;
end;
$$;

revoke all on function public.request_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.request_account_deletion(uuid) to service_role;

-- Storage objects are removed by the application before this transactional
-- database cleanup. The job row intentionally remains for durable audit state.
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

  -- Ensure a retried request can never restore a public endpoint.
  update public.workflows
  set public_form_enabled = false,
      published_at = null,
      lifecycle_state = 'disabled',
      current_version_id = null,
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

  update public.account_deletion_jobs
  set updated_at = clock_timestamp()
  where id = p_job_id;

  return true;
end;
$$;

revoke all on function public.cleanup_account_data(uuid, uuid) from public, anon, authenticated;
grant execute on function public.cleanup_account_data(uuid, uuid) to service_role;

commit;
