begin;

-- One owner-scoped, bounded copy of each authenticated public-channel event.
-- Event IDs are provider identities, not authorization identities.
alter table public.connector_connections
  add constraint connector_connections_id_workspace_owner_unique
  unique (id, workspace_id, user_id);

create table public.slack_message_events (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null,
  provider_event_id text not null,
  team_id text not null,
  channel_id text not null,
  sender_id text not null,
  message_ts text not null,
  thread_ts text,
  message_text text not null,
  message_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  constraint slack_message_events_connection_owner_fkey
    foreign key (connection_id, workspace_id, user_id)
    references public.connector_connections(id, workspace_id, user_id) on delete cascade,
  constraint slack_message_events_membership_fkey
    foreign key (workspace_id, user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade,
  constraint slack_message_events_event_length check (char_length(provider_event_id) between 1 and 200),
  constraint slack_message_events_team_format check (team_id ~ '^T[A-Z0-9]{7,20}$'),
  constraint slack_message_events_channel_format check (channel_id ~ '^C[A-Z0-9]{7,20}$'),
  constraint slack_message_events_sender_format check (sender_id ~ '^[UW][A-Z0-9]{7,20}$'),
  constraint slack_message_events_ts_format check (message_ts ~ '^[0-9]{10,20}\.[0-9]{1,10}$'),
  constraint slack_message_events_thread_format check (thread_ts is null or thread_ts ~ '^[0-9]{10,20}\.[0-9]{1,10}$'),
  constraint slack_message_events_text_length check (char_length(message_text) between 1 and 4000),
  unique (connection_id, provider_event_id)
);

create index slack_message_events_owner_recent_idx
  on public.slack_message_events(workspace_id, user_id, message_at desc);
create index slack_message_events_connection_channel_recent_idx
  on public.slack_message_events(connection_id, channel_id, message_at desc);

alter table public.slack_message_events enable row level security;
alter table public.slack_message_events force row level security;
revoke all on table public.slack_message_events from public, anon, authenticated;
grant select on table public.slack_message_events to authenticated;
grant select, insert, update, delete on table public.slack_message_events to service_role;

create policy slack_message_events_owner_select
  on public.slack_message_events for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = slack_message_events.workspace_id
        and membership.user_id = (select auth.uid()) and membership.is_default
    )
  );

commit;
