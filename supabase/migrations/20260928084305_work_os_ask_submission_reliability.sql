begin;

-- One durable row represents one deliberate Ask submission. Network retries use
-- request_id; attempt_token/attempt_generation are compare-and-set ownership for
-- the bounded provider attempt and are never exposed to the browser.
create table public.ask_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  thread_id uuid not null,
  user_id uuid not null,
  request_id uuid not null,
  question text not null,
  state text not null default 'processing',
  turn_sequence bigint not null,
  attempt_generation integer not null default 1,
  attempt_token uuid,
  lease_until timestamptz,
  failure_category text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  failed_at timestamptz,
  constraint ask_turns_membership_fkey foreign key (workspace_id, user_id)
    references public.workspace_memberships(workspace_id, user_id) on delete cascade,
  constraint ask_turns_thread_fkey foreign key (workspace_id, thread_id, user_id)
    references public.ask_threads(workspace_id, id, user_id) on delete cascade,
  constraint ask_turns_question_check check (char_length(trim(question)) between 1 and 2000),
  constraint ask_turns_state_check check (state in ('processing', 'completed', 'failed')),
  constraint ask_turns_sequence_check check (turn_sequence > 0),
  constraint ask_turns_attempt_generation_check check (attempt_generation > 0),
  constraint ask_turns_failure_category_check check (
    failure_category is null or failure_category in (
      'generation_failed', 'rate_limited', 'quota_exceeded', 'capacity_busy',
      'persistence_failed', 'interrupted', 'authorization_lost', 'unavailable'
    )
  ),
  constraint ask_turns_lifecycle_check check (
    (state = 'processing' and attempt_token is not null and lease_until is not null
      and failure_category is null and completed_at is null and failed_at is null)
    or
    (state = 'completed' and attempt_token is null and lease_until is null
      and failure_category is null and completed_at is not null and failed_at is null)
    or
    (state = 'failed' and attempt_token is null and lease_until is null
      and failure_category is not null and completed_at is null and failed_at is not null)
  ),
  constraint ask_turns_request_unique unique (workspace_id, user_id, request_id),
  constraint ask_turns_sequence_unique unique (workspace_id, thread_id, user_id, turn_sequence),
  constraint ask_turns_identity_unique unique (workspace_id, thread_id, user_id, id)
);

create unique index ask_turns_one_processing_per_thread_idx
  on public.ask_turns(workspace_id, thread_id, user_id)
  where state = 'processing';
create index ask_turns_owner_created_idx
  on public.ask_turns(workspace_id, user_id, created_at, id);
create index ask_turns_thread_sequence_idx
  on public.ask_turns(workspace_id, thread_id, user_id, turn_sequence);

alter table public.ask_messages
  add column turn_id uuid,
  add column turn_position smallint,
  add column sequence_no bigint,
  add constraint ask_messages_turn_fkey foreign key (workspace_id, thread_id, user_id, turn_id)
    references public.ask_turns(workspace_id, thread_id, user_id, id) on delete cascade,
  add constraint ask_messages_turn_fields_check check (
    (turn_id is null and turn_position is null and sequence_no is null)
    or
    (turn_id is not null and turn_position is not null and sequence_no is not null)
  ),
  add constraint ask_messages_turn_role_check check (
    turn_id is null
    or (role = 'user' and turn_position = 0)
    or (role = 'assistant' and turn_position = 1)
  ),
  add constraint ask_messages_sequence_check check (sequence_no is null or sequence_no > 0);

create unique index ask_messages_one_position_per_turn_idx
  on public.ask_messages(turn_id, turn_position)
  where turn_id is not null;
create unique index ask_messages_thread_sequence_unique_idx
  on public.ask_messages(workspace_id, thread_id, user_id, sequence_no)
  where sequence_no is not null;

alter table public.ask_turns enable row level security;
alter table public.ask_turns force row level security;
revoke all on table public.ask_turns from public, anon, authenticated;
grant select on table public.ask_turns to authenticated;
grant select, insert, update, delete on table public.ask_turns to service_role;

create policy ask_turns_owner_select on public.ask_turns
  for select to authenticated using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_memberships as membership
      where membership.workspace_id = ask_turns.workspace_id
        and membership.user_id = (select auth.uid())
        and membership.is_default
    )
    and exists (
      select 1 from public.ask_threads as thread
      where thread.id = ask_turns.thread_id
        and thread.workspace_id = ask_turns.workspace_id
        and thread.user_id = (select auth.uid())
    )
  );

-- The returned attempt token is server-only. The browser receives only the
-- sanitized application result produced after this RPC returns.
create function public.claim_ask_turn(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_thread_id uuid,
  p_question text,
  p_thread_title text,
  p_lease_seconds integer default 90
) returns table (
  disposition text,
  turn_id uuid,
  resolved_thread_id uuid,
  logical_request_id uuid,
  submitted_question text,
  turn_sequence bigint,
  user_sequence_no bigint,
  attempt_token uuid,
  attempt_generation integer,
  turn_state text,
  failure_category text,
  assistant_content text,
  assistant_metadata jsonb
)
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_thread public.ask_threads%rowtype;
  v_existing public.ask_turns%rowtype;
  v_active public.ask_turns%rowtype;
  v_turn public.ask_turns%rowtype;
  v_sequence bigint;
  v_token uuid;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_lease_seconds < 15 or p_lease_seconds > 300 then raise exception 'Invalid Ask lease'; end if;
  if char_length(trim(p_question)) not between 1 and 2000 then raise exception 'Invalid Ask question'; end if;

  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;

  -- Serializes the first request replay before either caller can create a
  -- conversation. This transaction ends before retrieval/provider work starts.
  perform pg_advisory_xact_lock(hashtextextended(
    'ask:' || p_actor_user_id::text || ':' || p_request_id::text, 0
  ));

  select turn.* into v_existing
  from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id;

  if found then
    if v_existing.question <> trim(p_question)
      or (p_thread_id is not null and p_thread_id <> v_existing.thread_id)
    then
      raise exception 'Ask request identity conflict';
    end if;
    select thread.* into strict v_thread
    from public.ask_threads as thread
    where thread.id = v_existing.thread_id
      and thread.workspace_id = v_workspace_id
      and thread.user_id = p_actor_user_id
    for update;
    select turn.* into strict v_existing
    from public.ask_turns as turn
    where turn.workspace_id = v_workspace_id
      and turn.user_id = p_actor_user_id
      and turn.request_id = p_request_id
    for update;
    if v_existing.question <> trim(p_question)
      or (p_thread_id is not null and p_thread_id <> v_existing.thread_id)
    then
      raise exception 'Ask request identity conflict';
    end if;
    if v_existing.state = 'processing' and v_existing.lease_until <= clock_timestamp() then
      update public.ask_turns as turn set
        state = 'failed', attempt_token = null, lease_until = null,
        failure_category = 'interrupted', failed_at = clock_timestamp(),
        updated_at = clock_timestamp()
      where turn.id = v_existing.id
      returning turn.* into v_existing;
    end if;
    return query
      select v_existing.state, v_existing.id, v_existing.thread_id,
        v_existing.request_id, v_existing.question, v_existing.turn_sequence,
        (v_existing.turn_sequence * 2 - 1), null::uuid,
        v_existing.attempt_generation, v_existing.state,
        v_existing.failure_category, message.content, message.response_metadata
      from (select 1) as singleton
      left join public.ask_messages as message
        on message.turn_id = v_existing.id and message.turn_position = 1;
    return;
  end if;

  if p_thread_id is null then
    insert into public.ask_threads (workspace_id, user_id, title)
    values (v_workspace_id, p_actor_user_id, p_thread_title)
    returning * into v_thread;
  else
    select thread.* into strict v_thread
    from public.ask_threads as thread
    where thread.id = p_thread_id
      and thread.workspace_id = v_workspace_id
      and thread.user_id = p_actor_user_id
    for update;
  end if;

  select turn.* into v_active
  from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.thread_id = v_thread.id
    and turn.user_id = p_actor_user_id
    and turn.state = 'processing'
  for update;
  if found and v_active.lease_until <= clock_timestamp() then
    update public.ask_turns as turn set
      state = 'failed', attempt_token = null, lease_until = null,
      failure_category = 'interrupted', failed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where turn.id = v_active.id;
    v_active.id := null;
  end if;
  if v_active.id is not null then
    return query select 'busy'::text, null::uuid, v_thread.id, p_request_id,
      trim(p_question), null::bigint, null::bigint, null::uuid, null::integer,
      null::text, null::text, null::text, null::jsonb;
    return;
  end if;

  select coalesce(max(turn.turn_sequence), 0) + 1 into v_sequence
  from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.thread_id = v_thread.id
    and turn.user_id = p_actor_user_id;
  v_token := gen_random_uuid();
  insert into public.ask_turns (
    workspace_id, thread_id, user_id, request_id, question, turn_sequence,
    attempt_token, lease_until
  ) values (
    v_workspace_id, v_thread.id, p_actor_user_id, p_request_id, trim(p_question),
    v_sequence, v_token, clock_timestamp() + make_interval(secs => p_lease_seconds)
  ) returning * into v_turn;
  insert into public.ask_messages (
    thread_id, workspace_id, user_id, role, content,
    turn_id, turn_position, sequence_no
  ) values (
    v_thread.id, v_workspace_id, p_actor_user_id, 'user', v_turn.question,
    v_turn.id, 0, v_turn.turn_sequence * 2 - 1
  );
  update public.ask_threads as thread set updated_at = clock_timestamp()
  where thread.id = v_thread.id
    and thread.workspace_id = v_workspace_id
    and thread.user_id = p_actor_user_id;

  return query select 'claimed'::text, v_turn.id, v_turn.thread_id,
    v_turn.request_id, v_turn.question, v_turn.turn_sequence,
    (v_turn.turn_sequence * 2 - 1), v_token, v_turn.attempt_generation,
    v_turn.state, null::text, null::text, null::jsonb;
end;
$$;

create function public.get_ask_turn_status(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_thread_id uuid default null
) returns table (
  disposition text,
  turn_id uuid,
  resolved_thread_id uuid,
  logical_request_id uuid,
  submitted_question text,
  turn_sequence bigint,
  user_sequence_no bigint,
  attempt_token uuid,
  attempt_generation integer,
  turn_state text,
  failure_category text,
  assistant_content text,
  assistant_metadata jsonb
)
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_turn public.ask_turns%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id;
  if p_thread_id is not null and p_thread_id <> v_turn.thread_id then
    raise exception 'Ask request identity conflict';
  end if;
  perform 1 from public.ask_threads as thread
  where thread.id = v_turn.thread_id and thread.workspace_id = v_workspace_id
    and thread.user_id = p_actor_user_id for update;
  if not found then raise exception 'Ask request is unavailable'; end if;
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id
  for update;
  if p_thread_id is not null and p_thread_id <> v_turn.thread_id then
    raise exception 'Ask request identity conflict';
  end if;
  if v_turn.state = 'processing' and v_turn.lease_until <= clock_timestamp() then
    update public.ask_turns as turn set
      state = 'failed', attempt_token = null, lease_until = null,
      failure_category = 'interrupted', failed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where turn.id = v_turn.id returning turn.* into v_turn;
  end if;
  return query
    select v_turn.state, v_turn.id, v_turn.thread_id, v_turn.request_id,
      v_turn.question, v_turn.turn_sequence, (v_turn.turn_sequence * 2 - 1),
      null::uuid, v_turn.attempt_generation, v_turn.state,
      v_turn.failure_category, message.content, message.response_metadata
    from (select 1) as singleton
    left join public.ask_messages as message
      on message.turn_id = v_turn.id and message.turn_position = 1;
end;
$$;

create function public.retry_ask_turn(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_thread_id uuid,
  p_lease_seconds integer default 90
) returns table (
  disposition text,
  turn_id uuid,
  resolved_thread_id uuid,
  logical_request_id uuid,
  submitted_question text,
  turn_sequence bigint,
  user_sequence_no bigint,
  attempt_token uuid,
  attempt_generation integer,
  turn_state text,
  failure_category text,
  assistant_content text,
  assistant_metadata jsonb
)
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_turn public.ask_turns%rowtype;
  v_latest_sequence bigint;
  v_token uuid;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_lease_seconds < 15 or p_lease_seconds > 300 then raise exception 'Invalid Ask lease'; end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;
  perform pg_advisory_xact_lock(hashtextextended(
    'ask:' || p_actor_user_id::text || ':' || p_request_id::text, 0
  ));
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id;
  if p_thread_id is not null and p_thread_id <> v_turn.thread_id then
    raise exception 'Ask request identity conflict';
  end if;
  perform 1 from public.ask_threads as thread
  where thread.id = v_turn.thread_id and thread.workspace_id = v_workspace_id
    and thread.user_id = p_actor_user_id for update;
  if not found then raise exception 'Ask request is unavailable'; end if;
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id
  for update;
  if p_thread_id is not null and p_thread_id <> v_turn.thread_id then
    raise exception 'Ask request identity conflict';
  end if;
  if v_turn.state = 'processing' and v_turn.lease_until <= clock_timestamp() then
    update public.ask_turns as turn set
      state = 'failed', attempt_token = null, lease_until = null,
      failure_category = 'interrupted', failed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where turn.id = v_turn.id returning turn.* into v_turn;
  end if;
  if v_turn.state <> 'failed' then
    return query
      select v_turn.state, v_turn.id, v_turn.thread_id, v_turn.request_id,
        v_turn.question, v_turn.turn_sequence, (v_turn.turn_sequence * 2 - 1),
        null::uuid, v_turn.attempt_generation, v_turn.state,
        v_turn.failure_category, message.content, message.response_metadata
      from (select 1) as singleton
      left join public.ask_messages as message
        on message.turn_id = v_turn.id and message.turn_position = 1;
    return;
  end if;
  select max(turn.turn_sequence) into v_latest_sequence
  from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id and turn.thread_id = v_turn.thread_id
    and turn.user_id = p_actor_user_id;
  if v_latest_sequence <> v_turn.turn_sequence then
    raise exception 'Only the latest Ask turn can be retried';
  end if;
  if exists (
    select 1 from public.ask_turns as active
    where active.workspace_id = v_workspace_id and active.thread_id = v_turn.thread_id
      and active.user_id = p_actor_user_id and active.state = 'processing'
      and active.id <> v_turn.id
  ) then
    return query select 'busy'::text, null::uuid, v_turn.thread_id, p_request_id,
      v_turn.question, null::bigint, null::bigint, null::uuid, null::integer,
      null::text, null::text, null::text, null::jsonb;
    return;
  end if;
  v_token := gen_random_uuid();
  update public.ask_turns as turn set
    state = 'processing', attempt_generation = turn.attempt_generation + 1,
    attempt_token = v_token,
    lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
    failure_category = null, failed_at = null, updated_at = clock_timestamp()
  where turn.id = v_turn.id returning turn.* into v_turn;
  return query select 'claimed'::text, v_turn.id, v_turn.thread_id,
    v_turn.request_id, v_turn.question, v_turn.turn_sequence,
    (v_turn.turn_sequence * 2 - 1), v_token, v_turn.attempt_generation,
    v_turn.state, null::text, null::text, null::jsonb;
end;
$$;

create function public.complete_ask_turn(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_attempt_token uuid,
  p_attempt_generation integer,
  p_answer text,
  p_response_metadata jsonb
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_turn public.ask_turns%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id;
  perform 1 from public.ask_threads as thread
  where thread.id = v_turn.thread_id and thread.workspace_id = v_workspace_id
    and thread.user_id = p_actor_user_id for update;
  if not found then return false; end if;
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id
  for update;
  if v_turn.state <> 'processing'
    or v_turn.attempt_token <> p_attempt_token
    or v_turn.attempt_generation <> p_attempt_generation
    or v_turn.lease_until <= clock_timestamp()
  then return false; end if;
  insert into public.ask_messages (
    thread_id, workspace_id, user_id, role, content, response_metadata,
    turn_id, turn_position, sequence_no
  ) values (
    v_turn.thread_id, v_workspace_id, p_actor_user_id, 'assistant', p_answer,
    p_response_metadata, v_turn.id, 1, v_turn.turn_sequence * 2
  );
  update public.ask_turns as turn set
    state = 'completed', attempt_token = null, lease_until = null,
    completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where turn.id = v_turn.id;
  update public.ask_threads as thread set updated_at = clock_timestamp()
  where thread.id = v_turn.thread_id and thread.workspace_id = v_workspace_id
    and thread.user_id = p_actor_user_id;
  return true;
end;
$$;

create function public.fail_ask_turn(
  p_actor_user_id uuid,
  p_request_id uuid,
  p_attempt_token uuid,
  p_attempt_generation integer,
  p_failure_category text
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_workspace_id uuid;
  v_turn public.ask_turns%rowtype;
begin
  if current_user <> 'service_role' then raise exception 'Unauthorized'; end if;
  if p_failure_category not in (
    'generation_failed', 'rate_limited', 'quota_exceeded', 'capacity_busy',
    'persistence_failed', 'interrupted', 'authorization_lost', 'unavailable'
  ) then raise exception 'Invalid Ask failure category'; end if;
  select membership.workspace_id into strict v_workspace_id
  from public.workspace_memberships as membership
  where membership.user_id = p_actor_user_id and membership.is_default;
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id;
  perform 1 from public.ask_threads as thread
  where thread.id = v_turn.thread_id and thread.workspace_id = v_workspace_id
    and thread.user_id = p_actor_user_id for update;
  if not found then return false; end if;
  select turn.* into strict v_turn from public.ask_turns as turn
  where turn.workspace_id = v_workspace_id
    and turn.user_id = p_actor_user_id
    and turn.request_id = p_request_id
  for update;
  if v_turn.state <> 'processing'
    or v_turn.attempt_token <> p_attempt_token
    or v_turn.attempt_generation <> p_attempt_generation
  then return false; end if;
  update public.ask_turns as turn set
    state = 'failed', attempt_token = null, lease_until = null,
    failure_category = p_failure_category, failed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where turn.id = v_turn.id;
  return true;
end;
$$;

revoke all on function public.claim_ask_turn(uuid, uuid, uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_ask_turn(uuid, uuid, uuid, text, text, integer)
  to service_role;
revoke all on function public.get_ask_turn_status(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_ask_turn_status(uuid, uuid, uuid)
  to service_role;
revoke all on function public.retry_ask_turn(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.retry_ask_turn(uuid, uuid, uuid, integer)
  to service_role;
revoke all on function public.complete_ask_turn(uuid, uuid, uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_ask_turn(uuid, uuid, uuid, integer, text, jsonb)
  to service_role;
revoke all on function public.fail_ask_turn(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.fail_ask_turn(uuid, uuid, uuid, integer, text)
  to service_role;

commit;
