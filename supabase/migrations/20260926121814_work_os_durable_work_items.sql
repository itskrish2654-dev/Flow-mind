begin;

-- Add the previously deferred covering index without changing workspace rules.
create index workspaces_created_by_idx
  on public.workspaces(created_by);

create table public.work_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  assignee_user_id uuid not null,
  title text not null,
  summary text,
  why_it_matters text,
  suggested_action text,
  status text not null default 'needs_you',
  priority text not null default 'normal',
  due_at timestamptz,
  source_type text not null,
  source_id text,
  source_label text,
  dedupe_key text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  constraint work_items_assignee_membership_fkey
    foreign key (workspace_id, assignee_user_id)
    references public.workspace_memberships(workspace_id, user_id)
    on delete cascade,
  constraint work_items_title_length_check check (char_length(trim(title)) between 1 and 180),
  constraint work_items_summary_length_check check (summary is null or char_length(summary) between 1 and 2000),
  constraint work_items_why_length_check check (why_it_matters is null or char_length(why_it_matters) between 1 and 1000),
  constraint work_items_action_length_check check (suggested_action is null or char_length(suggested_action) between 1 and 500),
  constraint work_items_status_check check (status in ('needs_you', 'waiting', 'handled', 'done')),
  constraint work_items_priority_check check (priority in ('low', 'normal', 'high')),
  constraint work_items_source_type_check check (source_type in ('workflow', 'workflow_execution', 'connector_event', 'system', 'internal')),
  constraint work_items_source_id_check check (
    (source_id is null or char_length(source_id) between 1 and 200)
    and (source_type not in ('workflow', 'workflow_execution', 'connector_event') or source_id is not null)
  ),
  constraint work_items_source_label_length_check check (source_label is null or char_length(source_label) between 1 and 120),
  constraint work_items_dedupe_key_length_check check (dedupe_key is null or char_length(dedupe_key) between 1 and 160),
  constraint work_items_resolution_check check (
    (status in ('done', 'handled') and resolved_at is not null)
    or (status in ('needs_you', 'waiting') and resolved_at is null)
  )
);

create index work_items_assignee_status_created_idx
  on public.work_items(workspace_id, assignee_user_id, status, created_at desc);

create unique index work_items_source_dedupe_idx
  on public.work_items(workspace_id, source_type, coalesce(source_id, ''), dedupe_key)
  where dedupe_key is not null;

alter table public.work_items enable row level security;
alter table public.work_items force row level security;

-- Data API grants and RLS are distinct. Browser clients can read only; all
-- mutations go through the authenticated, owner-scoped server service.
revoke all on table public.work_items from public, anon, authenticated;
grant select on table public.work_items to authenticated;
grant select, insert, update, delete on table public.work_items to service_role;

create policy work_items_assignee_select
  on public.work_items for select to authenticated
  using (
    assignee_user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = work_items.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

commit;
