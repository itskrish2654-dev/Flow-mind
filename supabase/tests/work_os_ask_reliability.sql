begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(36);

select extensions.has_table('public', 'ask_turns', 'durable Ask turns exist');
select extensions.has_function('public', 'claim_ask_turn', array['uuid','uuid','uuid','text','text','integer'], 'atomic claim RPC exists');
select extensions.ok(not has_function_privilege('anon', 'public.claim_ask_turn(uuid,uuid,uuid,text,text,integer)', 'execute'), 'anon cannot claim turns');
select extensions.ok(not has_function_privilege('authenticated', 'public.claim_ask_turn(uuid,uuid,uuid,text,text,integer)', 'execute'), 'browser role cannot claim turns');
select extensions.ok(has_function_privilege('service_role', 'public.claim_ask_turn(uuid,uuid,uuid,text,text,integer)', 'execute'), 'service role can call guarded claim');
select extensions.ok(not has_table_privilege('authenticated', 'public.ask_turns', 'select'), 'authenticated has no table-wide Ask turn SELECT');
select extensions.ok(
  has_column_privilege('authenticated', 'public.ask_turns', 'workspace_id', 'select')
  and has_column_privilege('authenticated', 'public.ask_turns', 'user_id', 'select')
  and has_column_privilege('authenticated', 'public.ask_turns', 'request_id', 'select')
  and has_column_privilege('authenticated', 'public.ask_turns', 'thread_id', 'select')
  and has_column_privilege('authenticated', 'public.ask_turns', 'state', 'select')
  and has_column_privilege('authenticated', 'public.ask_turns', 'failure_category', 'select'),
  'authenticated has the literal employee status column allowlist'
);
select extensions.ok(not has_column_privilege('authenticated', 'public.ask_turns', 'attempt_token', 'select'), 'attempt token is server-only');
select extensions.ok(not has_column_privilege('authenticated', 'public.ask_turns', 'attempt_generation', 'select'), 'attempt generation is server-only');
select extensions.ok(not has_column_privilege('authenticated', 'public.ask_turns', 'lease_until', 'select'), 'lease expiry is server-only');
select extensions.ok(not has_any_column_privilege('anon', 'public.ask_turns', 'select'), 'anon has no Ask turn column access');
select extensions.ok(not has_function_privilege('authenticated', 'public.complete_ask_turn(uuid,uuid,uuid,integer,text,jsonb)', 'execute'), 'browser role cannot complete turns');
select extensions.ok(not has_function_privilege('authenticated', 'public.fail_ask_turn(uuid,uuid,uuid,integer,text)', 'execute'), 'browser role cannot fail turns');
select extensions.ok(not has_function_privilege('authenticated', 'public.retry_ask_turn(uuid,uuid,uuid,integer)', 'execute'), 'browser role cannot retry turns');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, confirmation_token, recovery_token,
  email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'ask-a@example.invalid', '', clock_timestamp(), clock_timestamp(), clock_timestamp(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'ask-b@example.invalid', '', clock_timestamp(), clock_timestamp(), clock_timestamp(), '', '', '', '');

insert into public.workspaces (id, name, created_by)
values ('20000000-0000-4000-8000-000000000001', 'Ask reliability test', '10000000-0000-4000-8000-000000000001');
insert into public.workspace_memberships (workspace_id, user_id, role, is_default)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner', true),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'admin', true);

set local role service_role;
create temporary table unrelated_claim as
select * from public.claim_ask_turn(
  '10000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-0000000000f1',
  null,
  'Unrelated fixture question',
  'Unrelated fixture question',
  90
);
create temporary table first_claim as
select * from public.claim_ask_turn(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  null,
  'What needs me?',
  'What needs me?',
  90
);
grant select on table first_claim to authenticated;
select extensions.is((select disposition from first_claim), 'claimed', 'first submission is claimed');
select extensions.is((select count(*)::integer from public.ask_threads where id = (select resolved_thread_id from first_claim)), 1, 'first request creates one scoped conversation');
select extensions.is((select count(*)::integer from public.ask_messages where turn_id = (select turn_id from first_claim) and role = 'user'), 1, 'claim atomically creates one scoped user message');

create temporary table replay_claim as
select * from public.claim_ask_turn(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  null,
  'What needs me?',
  'Ignored replay title',
  90
);
select extensions.is((select disposition from replay_claim), 'processing', 'processing replay does not win a second attempt');
select extensions.is((select resolved_thread_id from replay_claim), (select resolved_thread_id from first_claim), 'first-message replay resolves the original conversation');
select extensions.is((select count(*)::integer from public.ask_messages where turn_id = (select turn_id from first_claim) and role = 'user'), 1, 'replay does not duplicate the scoped question');
select extensions.throws_ok(
  $$select * from public.claim_ask_turn('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',null,'Changed question','Changed',90)$$,
  'P0001', 'Ask request identity conflict', 'request ID cannot be rebound to changed content'
);

create temporary table busy_claim as
select * from public.claim_ask_turn(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  (select resolved_thread_id from first_claim),
  'Competing question',
  'Competing question',
  90
);
select extensions.is((select disposition from busy_claim), 'busy', 'different request in the active conversation is busy');
select extensions.is((select count(*)::integer from public.ask_turns where request_id in ('30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002')), 1, 'busy request creates no scoped turn');

select extensions.ok(public.complete_ask_turn(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  (select attempt_token from first_claim),
  (select attempt_generation from first_claim),
  'A durable answer',
  '{"version":1,"responseType":"answer","clarificationRequired":false,"references":[]}'::jsonb
), 'winning attempt completes');
select extensions.is((select state from public.ask_turns where id = (select turn_id from first_claim)), 'completed', 'scoped turn and answer commit together');
select extensions.is((select count(*)::integer from public.ask_messages where turn_id = (select turn_id from first_claim) and role = 'assistant'), 1, 'exactly one scoped assistant answer is committed');
select extensions.ok(not public.complete_ask_turn(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  (select attempt_token from first_claim),
  (select attempt_generation from first_claim),
  'Late answer',
  '{"version":1,"responseType":"answer","clarificationRequired":false,"references":[]}'::jsonb
), 'late duplicate completion is rejected');
select extensions.is((select count(*)::integer from public.ask_messages where turn_id = (select turn_id from first_claim) and role = 'assistant'), 1, 'late completion cannot append another scoped answer');

create temporary table completed_replay as
select * from public.get_ask_turn_status(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  (select resolved_thread_id from first_claim)
);
select extensions.is((select disposition from completed_replay), 'completed', 'completed replay returns stored state');
select extensions.is((select assistant_content from completed_replay), 'A durable answer', 'completed replay returns stored answer');
select extensions.is((select state from public.ask_turns where id = (select turn_id from unrelated_claim)), 'processing', 'unrelated synthetic conversation remains unchanged');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select extensions.is((select count(request_id)::integer from public.ask_turns where request_id = '30000000-0000-4000-8000-000000000001'), 0, 'same-workspace admin cannot read another employee Ask turn');
select extensions.is((select count(*)::integer from public.ask_messages where turn_id = (select turn_id from first_claim)), 0, 'same-workspace admin cannot read another employee Ask messages');

select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select extensions.is(
  (select count(request_id)::integer from public.ask_turns
    where workspace_id = '20000000-0000-4000-8000-000000000001'
      and user_id = '10000000-0000-4000-8000-000000000001'
      and request_id = '30000000-0000-4000-8000-000000000001'),
  1,
  'owner can read the exact safe employee status projection'
);
select extensions.throws_ok(
  $$select attempt_token from public.ask_turns where request_id = '30000000-0000-4000-8000-000000000001'$$,
  '42501', 'permission denied for table ask_turns', 'owner cannot select attempt token explicitly'
);
select extensions.throws_ok(
  $$select * from public.ask_turns where request_id = '30000000-0000-4000-8000-000000000001'$$,
  '42501', 'permission denied for table ask_turns', 'owner SELECT star cannot expose restricted columns'
);

reset role;
select * from extensions.finish();
rollback;
