begin;

alter table public.workflows
  add column if not exists public_form_enabled boolean not null default true;

create or replace function public.is_public_workflow(p_workflow_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workflows as workflow
    where workflow.id = p_workflow_id
      and workflow.public_form_enabled
      and workflow.compiled_steps is not null
  );
$$;

revoke all on function public.is_public_workflow(uuid) from public;
grant execute on function public.is_public_workflow(uuid) to anon, authenticated;

create or replace function public.get_public_workflow(p_workflow_id uuid)
returns table (
  id uuid,
  name text,
  compiled_steps jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select workflow.id, workflow.name, workflow.compiled_steps
  from public.workflows as workflow
  where workflow.id = p_workflow_id
    and workflow.public_form_enabled
    and workflow.compiled_steps is not null
  limit 1;
$$;

revoke all on function public.get_public_workflow(uuid) from public;
grant execute on function public.get_public_workflow(uuid) to anon, authenticated;

create table if not exists public.workflow_executions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  input_data jsonb not null default '{}'::jsonb,
  output_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint workflow_executions_input_object
    check (jsonb_typeof(input_data) = 'object'),
  constraint workflow_executions_output_object
    check (jsonb_typeof(output_data) = 'object'),
  constraint workflow_executions_input_size
    check (pg_column_size(input_data) <= 65536),
  constraint workflow_executions_output_size
    check (pg_column_size(output_data) <= 131072)
);

create index if not exists workflow_executions_workflow_created_idx
  on public.workflow_executions(workflow_id, created_at desc);

alter table public.workflow_executions enable row level security;
alter table public.workflow_executions force row level security;

revoke all on table public.workflow_executions from public, anon, authenticated;
grant insert on table public.workflow_executions to anon;
grant select, insert on table public.workflow_executions to authenticated;

drop policy if exists "Public forms can create execution logs" on public.workflow_executions;
drop policy if exists "Users can view their own execution logs" on public.workflow_executions;
drop policy if exists "Users can create their own execution logs" on public.workflow_executions;

create policy "Public forms can create execution logs"
  on public.workflow_executions
  for insert
  to anon
  with check (public.is_public_workflow(workflow_id));

create policy "Users can view their own execution logs"
  on public.workflow_executions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.workflows as workflow
      where workflow.id = workflow_executions.workflow_id
        and workflow.user_id = (select auth.uid())
    )
  );

create policy "Users can create their own execution logs"
  on public.workflow_executions
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.workflows as workflow
      where workflow.id = workflow_executions.workflow_id
        and workflow.user_id = (select auth.uid())
    )
  );

commit;
