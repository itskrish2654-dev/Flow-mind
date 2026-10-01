begin;

-- Polling observes Gmail's history high-watermark when Pub/Sub is not
-- configured. The existing ingestion lease remains the sole history worker.
alter table public.gmail_ingestion_states
  add column next_poll_at timestamptz not null default clock_timestamp(),
  add column last_polled_at timestamptz,
  add column poll_lease_token uuid,
  add column poll_lease_until timestamptz,
  add column poll_error_category text,
  add constraint gmail_work_poll_lease_pair check ((poll_lease_token is null) = (poll_lease_until is null));

create index gmail_work_poll_due_idx on public.gmail_ingestion_states(next_poll_at, poll_lease_until)
  where status not in ('reconnect_required', 'resync_required');

-- Gmail OAuth connections are stored under the canonical Google provider ID.
-- Keep the service-only approval transaction authoritative while accepting the
-- reviewed connector manifest's canonical provider-family connection.
create or replace function public.create_action_approval(
  p_actor_user_id uuid, p_source_message_id uuid, p_request_key text,
  p_action_title text, p_action_summary text, p_approval_reason text,
  p_capability_id text, p_connector_id text, p_operation_key text,
  p_operation_version integer, p_connection_id uuid, p_action_snapshot jsonb
) returns setof public.action_executions
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_item public.work_items%rowtype;
  v_approval public.approval_requests%rowtype;
  v_existing public.action_executions%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;

  if p_connection_id is not null and not exists (
    select 1 from public.connector_connections as connection
    where connection.id = p_connection_id and connection.user_id = p_actor_user_id
      and connection.workspace_id = v_workspace_id and connection.status = 'connected'
      and (
        connection.connector_id = p_connector_id
        or (
          connection.connector_id = connection.provider_family
          and connection.provider_family = split_part(p_connector_id, '_', 1)
        )
      )
  ) then raise exception 'Connection is unavailable'; end if;

  select * into v_existing from public.action_executions
  where workspace_id = v_workspace_id and idempotency_key = p_request_key;
  if found then
    if v_existing.requester_user_id <> p_actor_user_id
      or v_existing.source_message_id is distinct from p_source_message_id
      or v_existing.capability_id <> p_capability_id
      or v_existing.connector_id <> p_connector_id
      or v_existing.operation_key <> p_operation_key
      or v_existing.operation_version <> p_operation_version
      or v_existing.connection_id is distinct from p_connection_id
    then raise exception 'Action idempotency key belongs to another proposal'; end if;
    return query select * from public.action_executions where id = v_existing.id;
    return;
  end if;

  insert into public.work_items (
    workspace_id, assignee_user_id, title, summary, why_it_matters,
    suggested_action, status, priority, source_type, source_id, source_label, dedupe_key
  ) values (
    v_workspace_id, p_actor_user_id, p_action_title, p_action_summary,
    p_approval_reason, 'Review the exact action and approve or reject it.',
    'needs_you', 'normal', 'internal', p_source_message_id::text,
    'Ask CrazyLoops', p_request_key
  ) returning * into v_item;

  select * into strict v_approval from public.create_approval_request(
    p_actor_user_id, v_item.id, p_actor_user_id, 'internal',
    p_source_message_id::text, p_request_key, p_action_title,
    p_action_summary, p_approval_reason, p_capability_id, p_action_snapshot
  );

  return query insert into public.action_executions (
    workspace_id, requester_user_id, approval_request_id, work_item_id,
    source_message_id, connection_id, capability_id, connector_id,
    operation_key, operation_version, idempotency_key
  ) values (
    v_workspace_id, p_actor_user_id, v_approval.id, v_item.id,
    p_source_message_id, p_connection_id, p_capability_id, p_connector_id,
    p_operation_key, p_operation_version, p_request_key
  ) returning *;
end;
$$;

-- Queue a verified Gmail notification for a connected, owner-bound account
-- whenever a Work OS cursor or an active workflow subscription exists.
create or replace function public.enqueue_gmail_push_notification(
  p_email_address text, p_history_id text, p_pubsub_subscription text,
  p_pubsub_message_id text, p_publish_time timestamptz default null
) returns table (
  receipt_id uuid, connection_id uuid, inserted boolean,
  processed_history_id text, observed_history_id text
)
language plpgsql security invoker set search_path = '' as $$
declare
  v_connection record;
  v_receipt_id uuid;
  v_inserted boolean;
  v_processed text;
  v_observed text;
begin
  if p_email_address is null or p_email_address <> lower(p_email_address)
    or char_length(p_email_address) > 320
    or p_history_id !~ '^(0|[1-9][0-9]{0,19})$'
    or char_length(p_pubsub_subscription) not between 1 and 512
    or char_length(p_pubsub_message_id) not between 1 and 128
  then raise exception 'invalid Gmail push notification'; end if;

  for v_connection in
    select connection.id, connection.user_id,
      coalesce(state.processed_history_id, (
        select subscription.cursor_value from public.connector_subscriptions as subscription
        where subscription.connection_id = connection.id
          and subscription.user_id = connection.user_id
          and subscription.connector_id = 'google_gmail'
          and subscription.status = 'active'
          and subscription.cursor_value ~ '^(0|[1-9][0-9]{0,19})$'
        order by length(subscription.cursor_value), subscription.cursor_value limit 1
      )) as initial_cursor
    from public.connector_connections as connection
    left join public.gmail_ingestion_states as state on state.connection_id = connection.id
    where connection.provider_family = 'google'
      and connection.status = 'connected'
      and connection.external_account_id <> ''
      and connection.external_account_label = p_email_address
      and coalesce(state.processed_history_id, (
        select subscription.cursor_value from public.connector_subscriptions as subscription
        where subscription.connection_id = connection.id
          and subscription.user_id = connection.user_id
          and subscription.connector_id = 'google_gmail'
          and subscription.status = 'active'
          and subscription.cursor_value ~ '^(0|[1-9][0-9]{0,19})$'
        order by length(subscription.cursor_value), subscription.cursor_value limit 1
      )) is not null
  loop
    insert into public.gmail_ingestion_states (
      connection_id, user_id, processed_history_id, observed_history_id,
      status, next_attempt_at, updated_at
    ) values (
      v_connection.id, v_connection.user_id, v_connection.initial_cursor,
      case when length(p_history_id) > length(v_connection.initial_cursor)
        or (length(p_history_id) = length(v_connection.initial_cursor) and p_history_id > v_connection.initial_cursor)
        then p_history_id else v_connection.initial_cursor end,
      case when length(p_history_id) > length(v_connection.initial_cursor)
        or (length(p_history_id) = length(v_connection.initial_cursor) and p_history_id > v_connection.initial_cursor)
        then 'pending' else 'idle' end,
      clock_timestamp(), clock_timestamp()
    ) on conflict on constraint gmail_ingestion_states_pkey do update
      set observed_history_id = case
        when length(excluded.observed_history_id) > length(public.gmail_ingestion_states.observed_history_id)
          or (length(excluded.observed_history_id) = length(public.gmail_ingestion_states.observed_history_id)
            and excluded.observed_history_id > public.gmail_ingestion_states.observed_history_id)
          then excluded.observed_history_id else public.gmail_ingestion_states.observed_history_id end,
        status = case when public.gmail_ingestion_states.status in ('processing', 'resync_required')
          then public.gmail_ingestion_states.status
          when length(excluded.observed_history_id) > length(public.gmail_ingestion_states.processed_history_id)
            or (length(excluded.observed_history_id) = length(public.gmail_ingestion_states.processed_history_id)
              and excluded.observed_history_id > public.gmail_ingestion_states.processed_history_id)
          then 'pending' else 'idle' end,
        next_attempt_at = case when public.gmail_ingestion_states.status = 'resync_required'
          then public.gmail_ingestion_states.next_attempt_at
          else least(public.gmail_ingestion_states.next_attempt_at, clock_timestamp()) end,
        updated_at = clock_timestamp()
    returning public.gmail_ingestion_states.processed_history_id,
      public.gmail_ingestion_states.observed_history_id into v_processed, v_observed;

    v_receipt_id := null;
    insert into public.gmail_push_receipts (
      connection_id, user_id, pubsub_subscription, pubsub_message_id,
      history_id, publish_time, status, processed_at
    ) values (
      v_connection.id, v_connection.user_id, p_pubsub_subscription,
      p_pubsub_message_id, p_history_id, p_publish_time,
      case when length(p_history_id) < length(v_processed)
        or (length(p_history_id) = length(v_processed) and p_history_id <= v_processed)
        then 'succeeded' else 'queued' end,
      case when length(p_history_id) < length(v_processed)
        or (length(p_history_id) = length(v_processed) and p_history_id <= v_processed)
        then clock_timestamp() else null end
    ) on conflict on constraint gmail_push_receipts_pubsub_dedupe do nothing
    returning id into v_receipt_id;
    v_inserted := v_receipt_id is not null;
    if v_receipt_id is null then
      select receipt.id into v_receipt_id from public.gmail_push_receipts as receipt
      where receipt.connection_id = v_connection.id
        and receipt.pubsub_subscription = p_pubsub_subscription
        and receipt.pubsub_message_id = p_pubsub_message_id;
    end if;
    receipt_id := v_receipt_id; connection_id := v_connection.id; inserted := v_inserted;
    processed_history_id := v_processed; observed_history_id := v_observed; return next;
  end loop;
end;
$$;

create or replace function public.claim_gmail_ingestion(p_lease_seconds integer default 45)
returns table (connection_id uuid, user_id uuid, processed_history_id text, observed_history_id text, lease_token uuid)
language plpgsql security invoker set search_path = '' as $$
declare v_connection_id uuid; v_lease_token uuid := gen_random_uuid();
begin
  if p_lease_seconds < 15 or p_lease_seconds > 120 then raise exception 'invalid Gmail ingestion lease'; end if;
  select state.connection_id into v_connection_id
  from public.gmail_ingestion_states as state
  join public.connector_connections as connection
    on connection.id = state.connection_id and connection.user_id = state.user_id
    and connection.status = 'connected' and connection.provider_family = 'google'
  join public.workspace_memberships as membership
    on membership.workspace_id = connection.workspace_id and membership.user_id = state.user_id
  where state.status in ('pending', 'processing')
    and state.next_attempt_at <= clock_timestamp()
    and (state.lease_until is null or state.lease_until <= clock_timestamp())
    and (length(state.observed_history_id) > length(state.processed_history_id)
      or (length(state.observed_history_id) = length(state.processed_history_id)
        and state.observed_history_id > state.processed_history_id))
  order by state.next_attempt_at, state.updated_at for update of state skip locked limit 1;
  if v_connection_id is null then return; end if;
  return query update public.gmail_ingestion_states as state
  set status = 'processing', lease_token = v_lease_token,
    lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = clock_timestamp()
  where state.connection_id = v_connection_id
  returning state.connection_id, state.user_id, state.processed_history_id,
    state.observed_history_id, state.lease_token;
end;
$$;

create or replace function public.claim_gmail_work_poll(p_lease_seconds integer default 90)
returns table (connection_id uuid, user_id uuid, lease_token uuid)
language plpgsql security invoker set search_path = '' as $$
declare v_connection_id uuid; v_token uuid := gen_random_uuid();
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_lease_seconds < 15 or p_lease_seconds > 120 then raise exception 'invalid Gmail poll lease'; end if;
  select state.connection_id into v_connection_id
  from public.gmail_ingestion_states as state
  join public.connector_connections as connection
    on connection.id = state.connection_id and connection.user_id = state.user_id
    and connection.status = 'connected' and connection.provider_family = 'google'
    and 'https://www.googleapis.com/auth/gmail.readonly' = any(connection.granted_scopes)
  join public.workspace_memberships as membership
    on membership.workspace_id = connection.workspace_id and membership.user_id = state.user_id
  where state.status not in ('reconnect_required', 'resync_required')
    and state.next_poll_at <= clock_timestamp()
    and (state.poll_lease_until is null or state.poll_lease_until <= clock_timestamp())
  order by state.next_poll_at, state.updated_at
  for update of state skip locked limit 1;
  if v_connection_id is null then return; end if;
  return query update public.gmail_ingestion_states as state
  set poll_lease_token = v_token,
      poll_lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
  where state.connection_id = v_connection_id
  returning state.connection_id, state.user_id, state.poll_lease_token;
end;
$$;

create or replace function public.list_uninitialized_gmail_work_connections(p_limit integer default 2)
returns table (connection_id uuid, user_id uuid)
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_limit < 1 or p_limit > 5 then raise exception 'invalid Gmail intake batch'; end if;
  return query
    select connection.id, connection.user_id
    from public.connector_connections as connection
    join public.workspace_memberships as membership
      on membership.workspace_id = connection.workspace_id and membership.user_id = connection.user_id
    where connection.provider_family = 'google' and connection.status = 'connected'
      and 'https://www.googleapis.com/auth/gmail.readonly' = any(connection.granted_scopes)
      and not exists (select 1 from public.gmail_ingestion_states as state where state.connection_id = connection.id)
    order by connection.updated_at, connection.id limit p_limit;
end;
$$;

create or replace function public.complete_gmail_work_poll(
  p_connection_id uuid, p_user_id uuid, p_lease_token uuid, p_history_id text
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_updated integer;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_history_id !~ '^(0|[1-9][0-9]{0,19})$' then raise exception 'invalid Gmail history ID'; end if;
  update public.gmail_ingestion_states as state
  set observed_history_id = case
        when length(p_history_id) > length(state.observed_history_id)
          or (length(p_history_id) = length(state.observed_history_id) and p_history_id > state.observed_history_id)
        then p_history_id else state.observed_history_id end,
      status = case
        when state.status in ('processing', 'resync_required', 'reconnect_required') then state.status
        when length(p_history_id) > length(state.processed_history_id)
          or (length(p_history_id) = length(state.processed_history_id) and p_history_id > state.processed_history_id)
        then 'pending' else state.status end,
      next_attempt_at = case
        when state.status = 'resync_required' then state.next_attempt_at
        else least(state.next_attempt_at, clock_timestamp()) end,
      next_poll_at = clock_timestamp() + interval '5 minutes',
      last_polled_at = clock_timestamp(),
      poll_error_category = null,
      poll_lease_token = null, poll_lease_until = null,
      updated_at = clock_timestamp()
  where state.connection_id = p_connection_id and state.user_id = p_user_id
    and state.poll_lease_token = p_lease_token and state.poll_lease_until > clock_timestamp()
    and exists (
      select 1 from public.connector_connections as connection
      join public.workspace_memberships as membership
        on membership.workspace_id = connection.workspace_id and membership.user_id = connection.user_id
      where connection.id = state.connection_id and connection.user_id = state.user_id
        and connection.status = 'connected' and connection.provider_family = 'google'
        and 'https://www.googleapis.com/auth/gmail.readonly' = any(connection.granted_scopes)
    );
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.defer_gmail_work_poll(
  p_connection_id uuid, p_user_id uuid, p_lease_token uuid, p_error_category text
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_updated integer;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_error_category not in ('authentication', 'authorization', 'provider_unavailable', 'transient')
    then raise exception 'invalid Gmail poll error'; end if;
  update public.gmail_ingestion_states
  set next_poll_at = clock_timestamp() + interval '15 minutes',
      poll_error_category = p_error_category,
      poll_lease_token = null, poll_lease_until = null,
      updated_at = clock_timestamp()
  where connection_id = p_connection_id and user_id = p_user_id
    and poll_lease_token = p_lease_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function public.create_action_approval(uuid, uuid, text, text, text, text, text, text, text, integer, uuid, jsonb),
  public.enqueue_gmail_push_notification(text, text, text, text, timestamptz),
  public.claim_gmail_ingestion(integer),
  public.list_uninitialized_gmail_work_connections(integer),
  public.claim_gmail_work_poll(integer),
  public.complete_gmail_work_poll(uuid, uuid, uuid, text),
  public.defer_gmail_work_poll(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_action_approval(uuid, uuid, text, text, text, text, text, text, text, integer, uuid, jsonb),
  public.enqueue_gmail_push_notification(text, text, text, text, timestamptz),
  public.claim_gmail_ingestion(integer),
  public.list_uninitialized_gmail_work_connections(integer),
  public.claim_gmail_work_poll(integer),
  public.complete_gmail_work_poll(uuid, uuid, uuid, text),
  public.defer_gmail_work_poll(uuid, uuid, uuid, text) to service_role;

-- Deliberately do not activate this job when the migration is applied to an
-- isolated acceptance database. The service-only production activation runs
-- only after the server route and matching Vault secret have been verified.
create function public.configure_gmail_work_sync()
returns void
language plpgsql security definer set search_path = '' as $$
declare v_job_id bigint;
begin
  if not exists (select 1 from vault.decrypted_secrets
    where name = 'crazyloops_schedule_dispatch_secret' and char_length(decrypted_secret) >= 32)
  then raise exception 'Schedule dispatch secret is not configured'; end if;
  select jobid into v_job_id from cron.job where jobname = 'crazyloops-gmail-work-sync';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule(
    'crazyloops-gmail-work-sync',
    '*/5 * * * *',
    $job$
      select net.http_post(
        url := 'https://www.crazy-loops.com/api/operations/gmail-work-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'crazyloops_schedule_dispatch_secret' limit 1), '')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 55000
      )
    $job$
  );
end;
$$;
revoke all on function public.configure_gmail_work_sync() from public, anon, authenticated;
grant execute on function public.configure_gmail_work_sync() to service_role;

commit;
