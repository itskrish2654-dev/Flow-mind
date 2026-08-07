begin;

alter table public.workflows
  add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid();

create index if not exists workflows_user_id_idx
  on public.workflows(user_id);

alter table public.workflows enable row level security;
alter table public.workflows force row level security;

revoke all on table public.workflows from anon;
grant select, insert, update, delete on table public.workflows to authenticated;

drop policy if exists "Users can only view their own workflows" on public.workflows;
drop policy if exists "Users can only insert their own workflows" on public.workflows;
drop policy if exists "Users can only update their own workflows" on public.workflows;
drop policy if exists "Users can only delete their own workflows" on public.workflows;

create policy "Users can only view their own workflows"
  on public.workflows
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can only insert their own workflows"
  on public.workflows
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can only update their own workflows"
  on public.workflows
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can only delete their own workflows"
  on public.workflows
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- Apply the same ownership boundary if a child steps table exists.
do $migration$
begin
  if to_regclass('public.steps') is not null then
    execute 'alter table public.steps add column if not exists user_id uuid references auth.users(id) on delete cascade default auth.uid()';
    execute 'create index if not exists steps_user_id_idx on public.steps(user_id)';
    execute 'alter table public.steps enable row level security';
    execute 'alter table public.steps force row level security';
    execute 'revoke all on table public.steps from anon';
    execute 'grant select, insert, update, delete on table public.steps to authenticated';
    execute 'drop policy if exists "Users can only view their own steps" on public.steps';
    execute 'drop policy if exists "Users can only insert their own steps" on public.steps';
    execute 'drop policy if exists "Users can only update their own steps" on public.steps';
    execute 'drop policy if exists "Users can only delete their own steps" on public.steps';
    execute 'create policy "Users can only view their own steps" on public.steps for select to authenticated using ((select auth.uid()) = user_id)';
    execute 'create policy "Users can only insert their own steps" on public.steps for insert to authenticated with check ((select auth.uid()) = user_id)';
    execute 'create policy "Users can only update their own steps" on public.steps for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)';
    execute 'create policy "Users can only delete their own steps" on public.steps for delete to authenticated using ((select auth.uid()) = user_id)';
  end if;
end
$migration$;

commit;
