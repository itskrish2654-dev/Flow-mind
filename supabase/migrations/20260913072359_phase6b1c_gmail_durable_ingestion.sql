begin;

-- Gmail Pub/Sub is only an edge notification.  These rows make the edge
-- acknowledgement durable without pretending the notification is a Gmail
-- message or a workflow event.
create table public.gmail_ingestion_states (
  connection_id uuid primary key references public.connector_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  processed_history_id text not null,
  observed_history_id text not null,
  status text not null default 'pending'
    check (status in ('idle', 'pending', 'processing', 'resync_required', 'reconnect_required')),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
  last_error_category text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (processed_history_id ~ '^(0|[1-9][0-9]{0,19})$'),
  check (observed_history_id ~ '^(0|[1-9][0-9]{0,19})$'),
  check (
    length(observed_history_id) > length(processed_history_id)
    or (
      length(observed_history_id) = length(processed_history_id)
      and observed_history_id >= processed_history_id
    )
  ),
  check ((lease_token is null) = (lease_until is null))
);

create table public.gmail_push_receipts (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.gmail_ingestion_states(connection_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  pubsub_subscription text not null,
  pubsub_message_id text not null,
  history_id text not null,
  publish_time timestamptz,
  status text not null default 'queued'
    check (status in ('queued', 'succeeded', 'rejected')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
  last_error_category text,
  received_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  expires_at timestamptz not null default (clock_timestamp() + interval '30 days'),
  constraint gmail_push_receipts_pubsub_dedupe
    unique (connection_id, pubsub_subscription, pubsub_message_id),
  check (char_length(pubsub_subscription) between 1 and 512),
  check (char_length(pubsub_message_id) between 1 and 128),
  check (history_id ~ '^(0|[1-9][0-9]{0,19})$')
);

create index gmail_ingestion_states_drain_idx
  on public.gmail_ingestion_states(status, next_attempt_at, lease_until)
  where status in ('pending', 'processing');

create index gmail_push_receipts_expiry_idx
  on public.gmail_push_receipts(expires_at);

alter table public.gmail_ingestion_states enable row level security;
alter table public.gmail_ingestion_states force row level security;
alter table public.gmail_push_receipts enable row level security;
alter table public.gmail_push_receipts force row level security;

revoke all on public.gmail_ingestion_states, public.gmail_push_receipts
  from public, anon, authenticated;
grant all on public.gmail_ingestion_states, public.gmail_push_receipts
  to service_role;

-- One transaction binds the authenticated notification to durable, active
-- Gmail connections, records Pub/Sub dedupe, and raises the observed cursor.
-- The caller cannot choose an owner or connection identifier.
create function public.enqueue_gmail_push_notification(
  p_email_address text,
  p_history_id text,
  p_pubsub_subscription text,
  p_pubsub_message_id text,
  p_publish_time timestamptz default null
)
returns table (
  receipt_id uuid,
  connection_id uuid,
  inserted boolean,
  processed_history_id text,
  observed_history_id text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_connection record;
  v_receipt_id uuid;
  v_inserted boolean;
  v_processed text;
  v_observed text;
begin
  if p_email_address is null
    or p_email_address <> lower(p_email_address)
    or char_length(p_email_address) > 320
    or p_history_id !~ '^(0|[1-9][0-9]{0,19})$'
    or char_length(p_pubsub_subscription) not between 1 and 512
    or char_length(p_pubsub_message_id) not between 1 and 128
  then
    raise exception 'invalid Gmail push notification';
  end if;

  for v_connection in
    select connection.id, connection.user_id,
      (
        select subscription.cursor_value
        from public.connector_subscriptions as subscription
        where subscription.connection_id = connection.id
          and subscription.user_id = connection.user_id
          and subscription.connector_id = 'google_gmail'
          and subscription.status = 'active'
          and subscription.provider_subscription_id = connection.id::text
          and subscription.cursor_value ~ '^(0|[1-9][0-9]{0,19})$'
        order by length(subscription.cursor_value), subscription.cursor_value
        limit 1
      ) as initial_cursor
    from public.connector_connections as connection
    where connection.provider_family = 'google'
      and connection.status = 'connected'
      and connection.external_account_id <> ''
      and connection.external_account_label = p_email_address
      and exists (
        select 1
        from public.connector_subscriptions as subscription
        where subscription.connection_id = connection.id
          and subscription.user_id = connection.user_id
          and subscription.connector_id = 'google_gmail'
          and subscription.status = 'active'
          and subscription.provider_subscription_id = connection.id::text
          and subscription.cursor_value ~ '^(0|[1-9][0-9]{0,19})$'
      )
  loop
    insert into public.gmail_ingestion_states (
      connection_id, user_id, processed_history_id, observed_history_id,
      status, next_attempt_at, updated_at
    ) values (
      v_connection.id,
      v_connection.user_id,
      v_connection.initial_cursor,
      case
        when length(p_history_id) > length(v_connection.initial_cursor)
          or (length(p_history_id) = length(v_connection.initial_cursor) and p_history_id > v_connection.initial_cursor)
          then p_history_id
        else v_connection.initial_cursor
      end,
      case
        when length(p_history_id) > length(v_connection.initial_cursor)
          or (length(p_history_id) = length(v_connection.initial_cursor) and p_history_id > v_connection.initial_cursor)
          then 'pending'
        else 'idle'
      end,
      clock_timestamp(),
      clock_timestamp()
    )
    on conflict on constraint gmail_ingestion_states_pkey do update
    set observed_history_id = case
          when length(excluded.observed_history_id) > length(public.gmail_ingestion_states.observed_history_id)
            or (
              length(excluded.observed_history_id) = length(public.gmail_ingestion_states.observed_history_id)
              and excluded.observed_history_id > public.gmail_ingestion_states.observed_history_id
            )
            then excluded.observed_history_id
          else public.gmail_ingestion_states.observed_history_id
        end,
        status = case
          when public.gmail_ingestion_states.status in ('processing', 'resync_required')
            then public.gmail_ingestion_states.status
          when length(excluded.observed_history_id) > length(public.gmail_ingestion_states.processed_history_id)
            or (
              length(excluded.observed_history_id) = length(public.gmail_ingestion_states.processed_history_id)
              and excluded.observed_history_id > public.gmail_ingestion_states.processed_history_id
            )
            then 'pending'
          else 'idle'
        end,
        next_attempt_at = case
          when public.gmail_ingestion_states.status = 'resync_required'
            then public.gmail_ingestion_states.next_attempt_at
          else least(public.gmail_ingestion_states.next_attempt_at, clock_timestamp())
        end,
        updated_at = clock_timestamp()
    returning public.gmail_ingestion_states.processed_history_id,
      public.gmail_ingestion_states.observed_history_id
    into v_processed, v_observed;

    v_receipt_id := null;
    insert into public.gmail_push_receipts (
      connection_id, user_id, pubsub_subscription, pubsub_message_id,
      history_id, publish_time, status, processed_at
    ) values (
      v_connection.id,
      v_connection.user_id,
      p_pubsub_subscription,
      p_pubsub_message_id,
      p_history_id,
      p_publish_time,
      case
        when length(p_history_id) < length(v_processed)
          or (length(p_history_id) = length(v_processed) and p_history_id <= v_processed)
          then 'succeeded'
        else 'queued'
      end,
      case
        when length(p_history_id) < length(v_processed)
          or (length(p_history_id) = length(v_processed) and p_history_id <= v_processed)
          then clock_timestamp()
        else null
      end
    )
    on conflict on constraint gmail_push_receipts_pubsub_dedupe do nothing
    returning id into v_receipt_id;

    v_inserted := v_receipt_id is not null;
    if v_receipt_id is null then
      select receipt.id into v_receipt_id
      from public.gmail_push_receipts as receipt
      where receipt.connection_id = v_connection.id
        and receipt.pubsub_subscription = p_pubsub_subscription
        and receipt.pubsub_message_id = p_pubsub_message_id;
    end if;

    receipt_id := v_receipt_id;
    connection_id := v_connection.id;
    inserted := v_inserted;
    processed_history_id := v_processed;
    observed_history_id := v_observed;
    return next;
  end loop;
end;
$$;

create function public.claim_gmail_ingestion(p_lease_seconds integer default 45)
returns table (
  connection_id uuid,
  user_id uuid,
  processed_history_id text,
  observed_history_id text,
  lease_token uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_connection_id uuid;
  v_lease_token uuid := gen_random_uuid();
begin
  if p_lease_seconds < 15 or p_lease_seconds > 120 then
    raise exception 'invalid Gmail ingestion lease';
  end if;

  select state.connection_id into v_connection_id
  from public.gmail_ingestion_states as state
  join public.connector_connections as connection
    on connection.id = state.connection_id
    and connection.user_id = state.user_id
    and connection.status = 'connected'
    and connection.provider_family = 'google'
  where state.status in ('pending', 'processing')
    and state.next_attempt_at <= clock_timestamp()
    and (state.lease_until is null or state.lease_until <= clock_timestamp())
    and (
      length(state.observed_history_id) > length(state.processed_history_id)
      or (
        length(state.observed_history_id) = length(state.processed_history_id)
        and state.observed_history_id > state.processed_history_id
      )
    )
    and exists (
      select 1 from public.connector_subscriptions as subscription
      where subscription.connection_id = state.connection_id
        and subscription.user_id = state.user_id
        and subscription.connector_id = 'google_gmail'
        and subscription.status = 'active'
    )
  order by state.next_attempt_at, state.updated_at
  for update of state skip locked
  limit 1;

  if v_connection_id is null then return; end if;

  return query
  update public.gmail_ingestion_states as state
  set status = 'processing',
      lease_token = v_lease_token,
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
  where state.connection_id = v_connection_id
  returning state.connection_id, state.user_id, state.processed_history_id,
    state.observed_history_id, state.lease_token;
end;
$$;

create function public.complete_gmail_ingestion(
  p_connection_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_expected_processed_history_id text,
  p_completed_history_id text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_state public.gmail_ingestion_states%rowtype;
begin
  if p_connection_id is null or p_user_id is null or p_lease_token is null
    or p_expected_processed_history_id !~ '^(0|[1-9][0-9]{0,19})$'
    or p_completed_history_id !~ '^(0|[1-9][0-9]{0,19})$'
  then
    raise exception 'invalid Gmail ingestion completion';
  end if;

  select * into v_state
  from public.gmail_ingestion_states
  where connection_id = p_connection_id and user_id = p_user_id
  for update;

  if v_state.connection_id is null
    or v_state.status <> 'processing'
    or v_state.lease_token <> p_lease_token
    or v_state.lease_until <= clock_timestamp()
    or v_state.processed_history_id <> p_expected_processed_history_id
    or length(p_completed_history_id) < length(v_state.processed_history_id)
    or (length(p_completed_history_id) = length(v_state.processed_history_id) and p_completed_history_id < v_state.processed_history_id)
    or length(p_completed_history_id) > length(v_state.observed_history_id)
    or (length(p_completed_history_id) = length(v_state.observed_history_id) and p_completed_history_id > v_state.observed_history_id)
  then
    return false;
  end if;

  update public.gmail_ingestion_states
  set processed_history_id = p_completed_history_id,
      status = case
        when length(observed_history_id) > length(p_completed_history_id)
          or (length(observed_history_id) = length(p_completed_history_id) and observed_history_id > p_completed_history_id)
          then 'pending'
        else 'idle'
      end,
      lease_token = null,
      lease_until = null,
      next_attempt_at = clock_timestamp(),
      attempt_count = 0,
      last_error_category = null,
      updated_at = clock_timestamp()
  where connection_id = p_connection_id and user_id = p_user_id;

  update public.connector_subscriptions
  set cursor_value = p_completed_history_id,
      last_event_at = clock_timestamp(),
      last_error_category = null,
      updated_at = clock_timestamp()
  where connection_id = p_connection_id
    and user_id = p_user_id
    and connector_id = 'google_gmail'
    and status = 'active'
    and cursor_value ~ '^(0|[1-9][0-9]{0,19})$'
    and (
      length(cursor_value) < length(p_completed_history_id)
      or (length(cursor_value) = length(p_completed_history_id) and cursor_value <= p_completed_history_id)
    );

  update public.gmail_push_receipts
  set status = 'succeeded', processed_at = clock_timestamp(), last_error_category = null
  where connection_id = p_connection_id
    and status = 'queued'
    and (
      length(history_id) < length(p_completed_history_id)
      or (length(history_id) = length(p_completed_history_id) and history_id <= p_completed_history_id)
    );

  return true;
end;
$$;

create function public.defer_gmail_ingestion(
  p_connection_id uuid,
  p_user_id uuid,
  p_lease_token uuid,
  p_error_category text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_error_category not in ('transient', 'authentication', 'resync_required') then
    raise exception 'invalid Gmail ingestion failure';
  end if;

  update public.gmail_ingestion_states
  set status = case p_error_category
        when 'authentication' then 'reconnect_required'
        when 'resync_required' then 'resync_required'
        else 'pending'
      end,
      lease_token = null,
      lease_until = null,
      next_attempt_at = case
        when p_error_category = 'transient'
          then clock_timestamp() + make_interval(secs => least(300, 5 * (2 ^ least(attempt_count, 6))::integer))
        else clock_timestamp() + interval '1 day'
      end,
      attempt_count = least(attempt_count + 1, 1000),
      last_error_category = p_error_category,
      updated_at = clock_timestamp()
  where connection_id = p_connection_id
    and user_id = p_user_id
    and status = 'processing'
    and lease_token = p_lease_token;
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    update public.gmail_push_receipts
    set attempt_count = least(attempt_count + 1, 1000),
        last_error_category = p_error_category
    where connection_id = p_connection_id and status = 'queued';

    update public.connector_subscriptions
    set last_error_category = case
          when p_error_category = 'resync_required' then 'gmail_resync_required'
          when p_error_category = 'authentication' then 'authentication'
          else 'gmail_history_error'
        end,
        updated_at = clock_timestamp()
    where connection_id = p_connection_id
      and user_id = p_user_id
      and connector_id = 'google_gmail'
      and status = 'active';
  end if;

  return v_updated = 1;
end;
$$;

revoke all on function public.enqueue_gmail_push_notification(text, text, text, text, timestamptz),
  public.claim_gmail_ingestion(integer),
  public.complete_gmail_ingestion(uuid, uuid, uuid, text, text),
  public.defer_gmail_ingestion(uuid, uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.enqueue_gmail_push_notification(text, text, text, text, timestamptz),
  public.claim_gmail_ingestion(integer),
  public.complete_gmail_ingestion(uuid, uuid, uuid, text, text),
  public.defer_gmail_ingestion(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.run_connector_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_oauth_states integer := 0;
  v_receipts integer := 0;
  v_gmail_push_receipts integer := 0;
  v_expired_subscriptions integer := 0;
  v_expired_connections integer := 0;
begin
  delete from public.connector_oauth_states
  where expires_at < clock_timestamp() - interval '1 day';
  get diagnostics v_oauth_states = row_count;

  delete from public.connector_event_receipts where expires_at < clock_timestamp();
  get diagnostics v_receipts = row_count;

  delete from public.gmail_push_receipts where expires_at < clock_timestamp();
  get diagnostics v_gmail_push_receipts = row_count;

  update public.connector_subscriptions
  set status = 'expired', updated_at = clock_timestamp()
  where status = 'active' and expires_at is not null and expires_at < clock_timestamp();
  get diagnostics v_expired_subscriptions = row_count;

  update public.connector_connections connection
  set status = 'expired', updated_at = clock_timestamp()
  where connection.status = 'connected'
    and connection.token_expires_at is not null
    and connection.token_expires_at < clock_timestamp() - interval '5 minutes'
    and not (
      connection.provider_family = 'google'
      and connection.connector_id = 'google'
      and connection.auth_type = 'oauth2'
      and exists(
        select 1
        from public.connector_connection_credentials credential
        where credential.connection_id = connection.id
          and credential.user_id = connection.user_id
          and credential.credential_key = 'refresh_token'
          and credential.credential_type = 'oauth_refresh_token'
          and credential.ciphertext <> ''
          and credential.nonce <> ''
          and credential.auth_tag <> ''
          and credential.algorithm = 'aes-256-gcm'
          and credential.encryption_version = 1
      )
    );
  get diagnostics v_expired_connections = row_count;

  return jsonb_build_object(
    'expiredOauthStates', v_oauth_states,
    'expiredEventReceipts', v_receipts,
    'expiredGmailPushReceipts', v_gmail_push_receipts,
    'expiredSubscriptions', v_expired_subscriptions,
    'expiredConnections', v_expired_connections
  );
end;
$$;

revoke all on function public.run_connector_maintenance()
  from public, anon, authenticated;
grant execute on function public.run_connector_maintenance()
  to service_role;

commit;
