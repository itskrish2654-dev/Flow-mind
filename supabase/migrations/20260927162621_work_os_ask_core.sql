begin;

create table public.ask_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  title text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint ask_threads_membership_fkey foreign key (workspace_id, user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade,
  constraint ask_threads_title_check check (char_length(trim(title)) between 1 and 120),
  constraint ask_threads_identity_unique unique (workspace_id, id, user_id)
);

create index ask_threads_owner_updated_idx
  on public.ask_threads(workspace_id, user_id, updated_at desc, id);

create table public.ask_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  role text not null,
  content text not null,
  response_metadata jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint ask_messages_thread_fkey foreign key (workspace_id, thread_id, user_id)
    references public.ask_threads(workspace_id, id, user_id) on delete cascade,
  constraint ask_messages_role_check check (role in ('user', 'assistant')),
  constraint ask_messages_content_check check (char_length(trim(content)) between 1 and 8000),
  constraint ask_messages_metadata_check check (
    (role = 'user' and response_metadata is null)
    or (
      role = 'assistant'
      and coalesce(jsonb_typeof(response_metadata) = 'object', false)
      and response_metadata @> '{"version":1}'::jsonb
      and response_metadata ->> 'responseType' in ('answer', 'clarification', 'unsupported', 'action_preview')
      and jsonb_typeof(response_metadata -> 'clarificationRequired') = 'boolean'
      and jsonb_typeof(response_metadata -> 'references') = 'array'
      and jsonb_array_length(response_metadata -> 'references') <= 12
      and (response_metadata - array['version', 'responseType', 'clarificationRequired', 'references', 'suggestedAction', 'unsupportedReason']) = '{}'::jsonb
      and octet_length(response_metadata::text) <= 8192
    )
  )
);

create index ask_messages_thread_created_idx
  on public.ask_messages(workspace_id, thread_id, user_id, created_at, id);
create index ask_messages_owner_created_idx
  on public.ask_messages(workspace_id, user_id, created_at, id);

alter table public.ask_threads enable row level security;
alter table public.ask_threads force row level security;
alter table public.ask_messages enable row level security;
alter table public.ask_messages force row level security;

revoke all on table public.ask_threads from public, anon, authenticated;
revoke all on table public.ask_messages from public, anon, authenticated;
grant select on table public.ask_threads to authenticated;
grant select on table public.ask_messages to authenticated;
grant select, insert, update, delete on table public.ask_threads to service_role;
grant select, insert, update, delete on table public.ask_messages to service_role;

create policy ask_threads_owner_select on public.ask_threads
  for select to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = ask_threads.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
  );

create policy ask_messages_owner_select on public.ask_messages
  for select to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = ask_messages.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
    and exists (
      select 1 from public.ask_threads as thread
      where thread.id = ask_messages.thread_id
        and thread.workspace_id = ask_messages.workspace_id
        and thread.user_id = (select auth.uid())
    )
  );

commit;
