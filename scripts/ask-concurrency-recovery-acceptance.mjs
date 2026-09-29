import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Agent, request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const PROJECT_REF = "gamdxwtgccluifatcrrs";
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const ANSWER_METADATA = {
  version: 1,
  responseType: "answer",
  clarificationRequired: false,
  references: [],
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const literal = (value) => value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
const uuid = (value) => `${literal(value)}::uuid`;
const json = (value) => `${literal(JSON.stringify(value))}::jsonb`;

const accessToken = (await readFile(join(homedir(), ".supabase", "access-token"), "utf8")).trim();
assert.ok(accessToken, "Supabase Management API access token is required");
const apiAgent = new Agent({ keepAlive: false, maxSockets: 24 });
const requestedStage = process.env.ASK_ACCEPTANCE_STAGE ?? "all";
assert.ok(["all", "short-one", "short-two", "lease"].includes(requestedStage), "invalid acceptance stage");

function managementRequest(query, timeoutMs) {
  const body = JSON.stringify({ query });
  return new Promise((resolve, reject) => {
    const apiRequest = request(ENDPOINT, {
      method: "POST",
      agent: apiAgent,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
        status: response.statusCode ?? 500,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    apiRequest.setTimeout(timeoutMs, () => apiRequest.destroy(new Error("management request timed out")));
    apiRequest.on("error", reject);
    apiRequest.end(body);
  });
}

async function databaseQuery(query, { timeoutMs = 30_000, expectError = null } = {}) {
  const response = await managementRequest(query, timeoutMs);
  if (!response.ok) {
      if (expectError) {
        assert.match(response.text, expectError, "database error did not match the expected fail-closed outcome");
        return { expectedError: true, rows: [] };
      }
      throw new Error(`database query failed with HTTP ${response.status}`);
  }
  assert.equal(expectError, null, "database query unexpectedly succeeded");
  const parsed = response.text ? JSON.parse(response.text) : [];
  return { expectedError: false, rows: Array.isArray(parsed) ? parsed : [parsed] };
}

function serviceTransaction(selectSql, { applicationName = null, before = "", timeoutMs = 30_000 } = {}) {
  const app = applicationName
    ? `set local application_name = ${literal(applicationName)};`
    : "";
  return databaseQuery(`
    begin;
    set local statement_timeout = '20s';
    set local lock_timeout = '12s';
    set local role service_role;
    ${app}
    ${before}
    ${selectSql};
    commit;
  `, { timeoutMs });
}

function claimSelect({ actorId, requestId, threadId = null, question, leaseSeconds = 90 }) {
  return `select pg_backend_pid() as backend_pid,
      transaction_timestamp() as transaction_started_at,
      clock_timestamp() as transaction_finished_at,
      claimed.*
    from public.claim_ask_turn(
      ${uuid(actorId)}, ${uuid(requestId)}, ${uuid(threadId)},
      ${literal(question)}, ${literal(question)}, ${leaseSeconds}
    ) as claimed`;
}

function retrySelect({ actorId, requestId, threadId, leaseSeconds = 90 }) {
  return `select pg_backend_pid() as backend_pid,
      transaction_timestamp() as transaction_started_at,
      clock_timestamp() as transaction_finished_at,
      retried.*
    from public.retry_ask_turn(
      ${uuid(actorId)}, ${uuid(requestId)}, ${uuid(threadId)}, ${leaseSeconds}
    ) as retried`;
}

function completeSelect({ actorId, requestId, token, generation, answer = "Synthetic accepted answer", metadata = ANSWER_METADATA }) {
  return `select pg_backend_pid() as backend_pid,
      transaction_timestamp() as transaction_started_at,
      clock_timestamp() as transaction_finished_at,
      public.complete_ask_turn(
        ${uuid(actorId)}, ${uuid(requestId)}, ${uuid(token)}, ${generation},
        ${literal(answer)}, ${json(metadata)}
      ) as accepted`;
}

function failSelect({ actorId, requestId, token, generation, category = "generation_failed" }) {
  return `select public.fail_ask_turn(
      ${uuid(actorId)}, ${uuid(requestId)}, ${uuid(token)}, ${generation}, ${literal(category)}
    ) as accepted`;
}

function statusSelect({ actorId, requestId, threadId = null }) {
  return `select status.* from public.get_ask_turn_status(
      ${uuid(actorId)}, ${uuid(requestId)}, ${uuid(threadId)}
    ) as status`;
}

function one(result) {
  assert.equal(result.rows.length, 1, "expected exactly one database result row");
  return result.rows[0];
}

async function claim(input, options) {
  return one(await serviceTransaction(claimSelect(input), options));
}

async function retry(input, options) {
  return one(await serviceTransaction(retrySelect(input), options));
}

async function complete(input, options) {
  return one(await serviceTransaction(completeSelect(input), options));
}

async function fail(input, options) {
  return one(await serviceTransaction(failSelect(input), options));
}

async function status(input, options) {
  return one(await serviceTransaction(statusSelect(input), options));
}

function advisoryLock(actorId, requestId) {
  return `select pg_advisory_xact_lock(hashtextextended(
      'ask:' || ${uuid(actorId)}::text || ':' || ${uuid(requestId)}::text, 0
    ));`;
}

function threadLock(threadId) {
  return `select 1 from public.ask_threads where id = ${uuid(threadId)} for update;`;
}

function hold(seconds = 2) {
  return `select pg_sleep(${seconds});`;
}

async function concurrentPair(firstFactory, secondFactory, startDelayMs = 250) {
  const firstStarted = performance.now();
  const firstPromise = firstFactory();
  await delay(startDelayMs);
  const secondStarted = performance.now();
  const secondPromise = secondFactory();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const finished = performance.now();
  const firstRow = one(first);
  const secondRow = one(second);
  assert.notEqual(firstRow.backend_pid, secondRow.backend_pid, "race calls must use different PostgreSQL backends");
  assert.ok(firstStarted < secondStarted && secondStarted < finished, "client request intervals must overlap");
  return { first: firstRow, second: secondRow };
}

function assertOneClaim(rows) {
  assert.equal(rows.filter((row) => row.disposition === "claimed").length, 1);
  assert.equal(rows.filter((row) => row.disposition !== "claimed").length, 1);
}

async function exactCounts({ workspaceId, requestIds = [], threadIds = [] }) {
  const requestFilter = requestIds.length
    ? `and request_id in (${requestIds.map(uuid).join(",")})`
    : "";
  const threadFilter = threadIds.length
    ? `and thread_id in (${threadIds.map(uuid).join(",")})`
    : "";
  return one(await databaseQuery(`select
      (select count(*)::int from public.ask_threads where workspace_id = ${uuid(workspaceId)} ${threadIds.length ? `and id in (${threadIds.map(uuid).join(",")})` : ""}) as threads,
      (select count(*)::int from public.ask_turns where workspace_id = ${uuid(workspaceId)} ${requestFilter}) as turns,
      (select count(*)::int from public.ask_messages where workspace_id = ${uuid(workspaceId)} ${threadFilter}) as messages,
      (select count(*)::int from public.ask_messages where workspace_id = ${uuid(workspaceId)} ${threadFilter} and role = 'assistant') as assistant_messages`));
}

const runId = randomUUID();
const manifest = {
  users: [randomUUID(), randomUUID(), randomUUID()],
  workspaces: [randomUUID(), randomUUID()],
};
const [ownerId, adminId, outsiderId] = manifest.users;
const [workspaceId, outsiderWorkspaceId] = manifest.workspaces;

const report = {
  transport: null,
  sameRequest: { repetitions: 0 },
  sameThread: { repetitions: 0 },
  retryRace: { repetitions: 0 },
  independentThreads: { repetitions: 0 },
  completionRace: { repetitions: 0 },
  recoveryRace: { repetitions: 0 },
  lease: null,
  atomicity: null,
  staleEarlierTurn: null,
  ordering: null,
  membership: null,
  cleanup: null,
};

async function createFixtures() {
  await databaseQuery(`
    begin;
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, confirmation_token, recovery_token,
      email_change_token_new, email_change
    ) values
      ('00000000-0000-0000-0000-000000000000', ${uuid(ownerId)}, 'authenticated', 'authenticated', ${literal(`ask-owner-${runId}@example.invalid`)}, '', clock_timestamp(), clock_timestamp(), clock_timestamp(), '', '', '', ''),
      ('00000000-0000-0000-0000-000000000000', ${uuid(adminId)}, 'authenticated', 'authenticated', ${literal(`ask-admin-${runId}@example.invalid`)}, '', clock_timestamp(), clock_timestamp(), clock_timestamp(), '', '', '', ''),
      ('00000000-0000-0000-0000-000000000000', ${uuid(outsiderId)}, 'authenticated', 'authenticated', ${literal(`ask-outsider-${runId}@example.invalid`)}, '', clock_timestamp(), clock_timestamp(), clock_timestamp(), '', '', '', '');
    insert into public.workspaces (id, name, created_by) values
      (${uuid(workspaceId)}, ${literal(`Ask acceptance ${runId}`)}, ${uuid(ownerId)}),
      (${uuid(outsiderWorkspaceId)}, ${literal(`Ask outsider ${runId}`)}, ${uuid(outsiderId)});
    insert into public.workspace_memberships (workspace_id, user_id, role, is_default) values
      (${uuid(workspaceId)}, ${uuid(ownerId)}, 'owner', true),
      (${uuid(workspaceId)}, ${uuid(adminId)}, 'admin', true),
      (${uuid(outsiderWorkspaceId)}, ${uuid(outsiderId)}, 'owner', true);
    commit;
  `);
}

async function cleanupFixtures() {
  await databaseQuery(`
    begin;
    delete from public.ask_messages where workspace_id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)});
    delete from public.ask_turns where workspace_id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)});
    delete from public.ask_threads where workspace_id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)});
    delete from public.workspace_memberships where workspace_id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)});
    delete from public.workspaces where id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)});
    delete from auth.users where id in (${manifest.users.map(uuid).join(",")});
    commit;
  `);
}

async function cleanupFixturesWithRetry() {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await cleanupFixtures();
      return;
    } catch (error) {
      lastError = error;
      await delay(500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function createThread(actorId = ownerId, targetWorkspaceId = workspaceId) {
  const threadId = randomUUID();
  await databaseQuery(`insert into public.ask_threads (id, workspace_id, user_id, title)
    values (${uuid(threadId)}, ${uuid(targetWorkspaceId)}, ${uuid(actorId)}, 'Synthetic acceptance thread')`);
  return threadId;
}

async function transportProbe() {
  const lockName = `ask-acceptance-${runId}`;
  const appName = `cl_ask_accept_${runId.slice(0, 8)}_transport`;
  const sleeper = databaseQuery(`
    with configured as materialized (
      select set_config('application_name', ${literal(appName)}, true)
    ), locked as materialized (
      select pg_backend_pid() as backend_pid,
        pg_advisory_xact_lock(hashtextextended(${literal(lockName)}, 0))
      from configured
    )
    select backend_pid, pg_sleep(6) from locked
  `, { timeoutMs: 15_000 });
  let observer = null;
  for (let attempt = 0; attempt < 6 && !observer; attempt += 1) {
    await delay(350);
    const result = one(await databaseQuery(`select pg_backend_pid() as observer_pid,
      (select pid from pg_stat_activity where application_name = ${literal(appName)} limit 1) as sleeper_pid,
      not pg_try_advisory_xact_lock(hashtextextended(${literal(lockName)}, 0)) as lock_observed`));
    if (result.sleeper_pid && result.lock_observed) observer = result;
  }
  assert.ok(observer, "independent overlapping Management API transactions were not observed");
  const sleeperRow = one(await sleeper);
  assert.notEqual(observer.observer_pid, sleeperRow.backend_pid);
  assert.equal(observer.sleeper_pid, sleeperRow.backend_pid);
  report.transport = { separateBackends: true, advisoryLockObserved: true, bounded: true };
}

async function sameRequestRaces() {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const requestId = randomUUID();
    const question = `Identical first request ${repetition}`;
    const appBase = `cl_ask_accept_${runId.slice(0, 8)}_same_${repetition}`;
    const pair = await concurrentPair(
      () => serviceTransaction(claimSelect({ actorId: ownerId, requestId, question }), {
        applicationName: `${appBase}_a`,
        before: `${advisoryLock(ownerId, requestId)} ${hold()}`,
      }),
      () => serviceTransaction(claimSelect({ actorId: ownerId, requestId, question }), { applicationName: `${appBase}_b` }),
    );
    assertOneClaim([pair.first, pair.second]);
    const winner = [pair.first, pair.second].find((row) => row.disposition === "claimed");
    const replay = [pair.first, pair.second].find((row) => row.disposition !== "claimed");
    assert.equal(replay.resolved_thread_id, winner.resolved_thread_id);
    assert.equal(replay.turn_id, winner.turn_id);
    const counts = await exactCounts({ workspaceId, requestIds: [requestId], threadIds: [winner.resolved_thread_id] });
    assert.deepEqual({ threads: counts.threads, turns: counts.turns, messages: counts.messages }, { threads: 1, turns: 1, messages: 1 });
    await databaseQuery(`
      begin;
      set local role service_role;
      select * from public.claim_ask_turn(${uuid(ownerId)}, ${uuid(requestId)}, null, 'Conflicting content', 'Conflicting content', 90);
      commit;
    `, { expectError: /Ask request identity conflict/ });
    report.sameRequest.repetitions += 1;
  }
  report.sameRequest.pass = true;
}

async function sameThreadRaces() {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const threadId = await createThread();
    const firstRequest = randomUUID();
    const secondRequest = randomUUID();
    const firstQuestion = `Contender A ${repetition}`;
    const secondQuestion = `Contender B ${repetition}`;
    const appBase = `cl_ask_accept_${runId.slice(0, 8)}_thread_${repetition}`;
    const pair = await concurrentPair(
      () => serviceTransaction(claimSelect({ actorId: ownerId, requestId: firstRequest, threadId, question: firstQuestion }), {
        applicationName: `${appBase}_a`,
        before: `${threadLock(threadId)} ${hold()}`,
      }),
      () => serviceTransaction(claimSelect({ actorId: ownerId, requestId: secondRequest, threadId, question: secondQuestion }), { applicationName: `${appBase}_b` }),
    );
    assertOneClaim([pair.first, pair.second]);
    const winner = pair.first.disposition === "claimed" ? pair.first : pair.second;
    const loser = pair.first.disposition === "claimed" ? pair.second : pair.first;
    const winnerRequest = pair.first.disposition === "claimed" ? firstRequest : secondRequest;
    const loserRequest = pair.first.disposition === "claimed" ? secondRequest : firstRequest;
    const loserQuestion = pair.first.disposition === "claimed" ? secondQuestion : firstQuestion;
    assert.equal(loser.disposition, "busy");
    const countsBefore = await exactCounts({ workspaceId, requestIds: [firstRequest, secondRequest], threadIds: [threadId] });
    assert.equal(countsBefore.turns, 1);
    assert.equal(countsBefore.messages, 1);
    assert.equal((await complete({ actorId: ownerId, requestId: winnerRequest, token: winner.attempt_token, generation: winner.attempt_generation })).accepted, true);
    const acceptedLater = await claim({ actorId: ownerId, requestId: loserRequest, threadId, question: loserQuestion });
    assert.equal(acceptedLater.disposition, "claimed");
    const countsAfter = await exactCounts({ workspaceId, requestIds: [firstRequest, secondRequest], threadIds: [threadId] });
    assert.equal(countsAfter.turns, 2);
    assert.equal(countsAfter.messages, 3);
    report.sameThread.repetitions += 1;
  }
  report.sameThread.pass = true;
}

async function retryRaces() {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const requestId = randomUUID();
    const initial = await claim({ actorId: ownerId, requestId, question: `Retry race ${repetition}` });
    assert.equal((await fail({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation })).accepted, true);
    const appBase = `cl_ask_accept_${runId.slice(0, 8)}_retry_${repetition}`;
    const pair = await concurrentPair(
      () => serviceTransaction(retrySelect({ actorId: ownerId, requestId, threadId: initial.resolved_thread_id }), {
        applicationName: `${appBase}_a`,
        before: `${advisoryLock(ownerId, requestId)} ${hold()}`,
      }),
      () => serviceTransaction(retrySelect({ actorId: ownerId, requestId, threadId: initial.resolved_thread_id }), { applicationName: `${appBase}_b` }),
    );
    assertOneClaim([pair.first, pair.second]);
    const winner = pair.first.disposition === "claimed" ? pair.first : pair.second;
    const replay = pair.first.disposition === "claimed" ? pair.second : pair.first;
    assert.equal(replay.disposition, "processing");
    assert.equal(winner.attempt_generation, initial.attempt_generation + 1);
    assert.equal(replay.attempt_generation, winner.attempt_generation);
    const counts = await exactCounts({ workspaceId, requestIds: [requestId], threadIds: [initial.resolved_thread_id] });
    assert.equal(counts.turns, 1);
    assert.equal(counts.messages, 1);
    report.retryRace.repetitions += 1;
  }
  report.retryRace.pass = true;
}

async function independentThreadRaces() {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const firstThread = await createThread();
    const secondThread = await createThread();
    const firstRequest = randomUUID();
    const secondRequest = randomUUID();
    const appBase = `cl_ask_accept_${runId.slice(0, 8)}_independent_${repetition}`;
    const firstPromise = serviceTransaction(claimSelect({ actorId: ownerId, requestId: firstRequest, threadId: firstThread, question: `Held ${repetition}` }), {
      applicationName: `${appBase}_a`,
      before: `${threadLock(firstThread)} ${hold(4)}`,
    });
    await delay(300);
    const secondStarted = performance.now();
    const second = one(await serviceTransaction(claimSelect({ actorId: ownerId, requestId: secondRequest, threadId: secondThread, question: `Independent ${repetition}` }), { applicationName: `${appBase}_b` }));
    const secondElapsed = performance.now() - secondStarted;
    const first = one(await firstPromise);
    assert.notEqual(first.backend_pid, second.backend_pid);
    assert.equal(first.disposition, "claimed");
    assert.equal(second.disposition, "claimed");
    assert.ok(new Date(second.transaction_finished_at) < new Date(first.transaction_finished_at), "independent thread should complete while the other thread remains held");
    assert.ok(secondElapsed < 3_800, "independent thread unexpectedly serialized behind the held thread");
    report.independentThreads.repetitions += 1;
  }
  report.independentThreads.pass = true;
}

async function completionRaces() {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const requestId = randomUUID();
    const initial = await claim({ actorId: ownerId, requestId, question: `Completion race ${repetition}` });
    const completionInput = { actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation, answer: `One answer ${repetition}` };
    const appBase = `cl_ask_accept_${runId.slice(0, 8)}_complete_${repetition}`;
    const pair = await concurrentPair(
      () => serviceTransaction(completeSelect(completionInput), {
        applicationName: `${appBase}_a`,
        before: `${threadLock(initial.resolved_thread_id)} ${hold()}`,
      }),
      () => serviceTransaction(completeSelect(completionInput), { applicationName: `${appBase}_b` }),
    );
    assert.equal([pair.first.accepted, pair.second.accepted].filter(Boolean).length, 1);
    const counts = await exactCounts({ workspaceId, requestIds: [requestId], threadIds: [initial.resolved_thread_id] });
    assert.equal(counts.assistant_messages, 1);
    const stored = one(await databaseQuery(`select state,
      (select count(*)::int from public.ask_messages where turn_id = turn.id and role = 'assistant') as answers
      from public.ask_turns as turn where request_id = ${uuid(requestId)}`));
    assert.deepEqual({ state: stored.state, answers: stored.answers }, { state: "completed", answers: 1 });
    report.completionRace.repetitions += 1;
  }
  report.completionRace.pass = true;
}

async function recoveryRaces() {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const requestId = randomUUID();
    const initial = await claim({ actorId: ownerId, requestId, question: `Recovery race ${repetition}`, leaseSeconds: 15 });
    await databaseQuery(`update public.ask_turns set lease_until = clock_timestamp() - interval '1 second'
      where workspace_id = ${uuid(workspaceId)} and request_id = ${uuid(requestId)}`);
    const appBase = `cl_ask_accept_${runId.slice(0, 8)}_recovery_${repetition}`;
    const pair = await concurrentPair(
      () => serviceTransaction(retrySelect({ actorId: ownerId, requestId, threadId: initial.resolved_thread_id }), {
        applicationName: `${appBase}_a`,
        before: `${advisoryLock(ownerId, requestId)} ${threadLock(initial.resolved_thread_id)} ${hold()}`,
      }),
      () => serviceTransaction(completeSelect({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation, answer: "Stale answer" }), { applicationName: `${appBase}_b` }),
    );
    assert.equal(pair.first.disposition, "claimed");
    assert.equal(pair.first.attempt_generation, initial.attempt_generation + 1);
    assert.equal(pair.second.accepted, false);
    assert.equal((await fail({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation })).accepted, false);
    assert.equal((await complete({ actorId: ownerId, requestId, token: pair.first.attempt_token, generation: pair.first.attempt_generation, answer: `Replacement answer ${repetition}` })).accepted, true);
    const counts = await exactCounts({ workspaceId, requestIds: [requestId], threadIds: [initial.resolved_thread_id] });
    assert.equal(counts.assistant_messages, 1);
    report.recoveryRace.repetitions += 1;
  }
  report.recoveryRace.pass = true;
}

async function atomicityAndReplay() {
  const requestId = randomUUID();
  const initial = await claim({ actorId: ownerId, requestId, question: "Atomic completion" });
  await databaseQuery(`
    begin;
    set local role service_role;
    ${completeSelect({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation, answer: "" })};
    commit;
  `, { expectError: /ask_messages_content_check|violates check constraint/ });
  const afterInvalid = one(await databaseQuery(`select state,
    (select count(*)::int from public.ask_messages where turn_id = turn.id and role = 'assistant') as answers
    from public.ask_turns as turn where request_id = ${uuid(requestId)}`));
  assert.deepEqual({ state: afterInvalid.state, answers: afterInvalid.answers }, { state: "processing", answers: 0 });
  const valid = await complete({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation, answer: "Recovered committed answer" });
  assert.equal(valid.accepted, true);
  const replay = await status({ actorId: ownerId, requestId, threadId: initial.resolved_thread_id });
  assert.equal(replay.disposition, "completed");
  assert.equal(replay.assistant_content, "Recovered committed answer");
  assert.equal((await complete({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation, answer: "Duplicate" })).accepted, false);
  const counts = await exactCounts({ workspaceId, requestIds: [requestId], threadIds: [initial.resolved_thread_id] });
  assert.equal(counts.assistant_messages, 1);
  report.atomicity = { invalidRolledBack: true, replayRecovered: true, duplicateRejected: true };
}

async function realLeaseExpiry() {
  const requestId = randomUUID();
  const initial = await claim({ actorId: ownerId, requestId, question: "Real ninety second lease", leaseSeconds: 90 });
  const before = one(await databaseQuery(`select state,
    (lease_until > clock_timestamp()) as lease_future,
    extract(epoch from (lease_until - clock_timestamp()))::int as seconds_remaining
    from public.ask_turns where request_id = ${uuid(requestId)}`));
  assert.equal(before.state, "processing");
  assert.equal(before.lease_future, true);
  assert.ok(before.seconds_remaining >= 80 && before.seconds_remaining <= 90);
  const waitStarted = performance.now();
  await delay(92_000);
  const elapsedSeconds = Math.floor((performance.now() - waitStarted) / 1000);
  assert.ok(elapsedSeconds >= 90);
  assert.equal((await complete({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation, answer: "Expired answer" })).accepted, false);
  const expired = await status({ actorId: ownerId, requestId, threadId: initial.resolved_thread_id });
  assert.equal(expired.disposition, "failed");
  assert.equal(expired.failure_category, "interrupted");
  const replacement = await retry({ actorId: ownerId, requestId, threadId: initial.resolved_thread_id, leaseSeconds: 90 });
  assert.equal(replacement.disposition, "claimed");
  assert.equal(replacement.attempt_generation, initial.attempt_generation + 1);
  assert.notEqual(replacement.attempt_token, initial.attempt_token);
  assert.equal((await complete({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation, answer: "Old answer" })).accepted, false);
  assert.equal((await fail({ actorId: ownerId, requestId, token: initial.attempt_token, generation: initial.attempt_generation })).accepted, false);
  assert.equal((await complete({ actorId: ownerId, requestId, token: randomUUID(), generation: replacement.attempt_generation, answer: "Wrong token" })).accepted, false);
  assert.equal((await fail({ actorId: ownerId, requestId, token: randomUUID(), generation: replacement.attempt_generation })).accepted, false);
  assert.equal((await complete({ actorId: ownerId, requestId, token: replacement.attempt_token, generation: replacement.attempt_generation, answer: "Valid replacement" })).accepted, true);
  const counts = await exactCounts({ workspaceId, requestIds: [requestId], threadIds: [initial.resolved_thread_id] });
  assert.equal(counts.assistant_messages, 1);
  report.lease = { secondsConfigured: 90, elapsedSeconds, recovered: true, staleRejected: true, oneAnswer: true };
}

async function staleEarlierTurn() {
  const threadId = await createThread();
  const earlierRequest = randomUUID();
  const laterRequest = randomUUID();
  const earlier = await claim({ actorId: ownerId, requestId: earlierRequest, threadId, question: "Earlier failed question" });
  assert.equal((await fail({ actorId: ownerId, requestId: earlierRequest, token: earlier.attempt_token, generation: earlier.attempt_generation })).accepted, true);
  const later = await claim({ actorId: ownerId, requestId: laterRequest, threadId, question: "Later question" });
  assert.equal(later.disposition, "claimed");
  await databaseQuery(`
    begin;
    set local role service_role;
    select * from public.retry_ask_turn(${uuid(ownerId)}, ${uuid(earlierRequest)}, ${uuid(threadId)}, 90);
    commit;
  `, { expectError: /Only the latest Ask turn can be retried/ });
  const earlierState = one(await databaseQuery(`select state, attempt_generation from public.ask_turns where request_id = ${uuid(earlierRequest)}`));
  assert.equal(earlierState.state, "failed");
  assert.equal(earlierState.attempt_generation, 1);
  report.staleEarlierTurn = { retryRejected: true };
}

async function orderingChecks() {
  const firstThread = await createThread();
  const secondThread = await createThread();
  const firstLegacyId = randomUUID();
  const secondLegacyId = randomUUID();
  await databaseQuery(`insert into public.ask_messages (
      id, thread_id, workspace_id, user_id, role, content, turn_id, turn_position, sequence_no, created_at
    ) values
      (${uuid(firstLegacyId)}, ${uuid(firstThread)}, ${uuid(workspaceId)}, ${uuid(ownerId)}, 'user', 'Legacy A', null, null, null, '2026-01-01T00:00:00Z'),
      (${uuid(secondLegacyId)}, ${uuid(secondThread)}, ${uuid(workspaceId)}, ${uuid(ownerId)}, 'user', 'Legacy B', null, null, null, '2026-01-01T00:00:00Z')`);
  const first = await claim({ actorId: ownerId, requestId: randomUUID(), threadId: firstThread, question: "Sequenced A" });
  assert.equal((await complete({ actorId: ownerId, requestId: first.logical_request_id, token: first.attempt_token, generation: first.attempt_generation, answer: "Answer A" })).accepted, true);
  const second = await claim({ actorId: ownerId, requestId: randomUUID(), threadId: secondThread, question: "Sequenced B" });
  assert.equal((await fail({ actorId: ownerId, requestId: second.logical_request_id, token: second.attempt_token, generation: second.attempt_generation })).accepted, true);
  await databaseQuery(`update public.ask_messages set created_at = case
      when sequence_no = 1 then '2026-12-01T00:00:00Z'::timestamptz
      when sequence_no = 2 then '2026-02-01T00:00:00Z'::timestamptz
      else created_at end
    where workspace_id = ${uuid(workspaceId)} and thread_id in (${uuid(firstThread)}, ${uuid(secondThread)})`);
  const ordered = (await databaseQuery(`select id, thread_id, sequence_no, role from public.ask_messages
    where workspace_id = ${uuid(workspaceId)} and thread_id in (${uuid(firstThread)}, ${uuid(secondThread)})
    order by thread_id asc, sequence_no asc nulls first, created_at asc, id asc`)).rows;
  const expectedThreads = [firstThread, secondThread].sort();
  assert.deepEqual([...new Set(ordered.map((row) => row.thread_id))], expectedThreads);
  for (const threadId of expectedThreads) {
    const rows = ordered.filter((row) => row.thread_id === threadId);
    assert.equal(rows[0].sequence_no, null);
    assert.equal(rows[1].sequence_no, 1);
    if (threadId === firstThread) assert.equal(rows[2].sequence_no, 2);
  }
  const limited = (await databaseQuery(`select id, thread_id, sequence_no from public.ask_messages
    where workspace_id = ${uuid(workspaceId)} and thread_id in (${uuid(firstThread)}, ${uuid(secondThread)})
    order by thread_id asc, sequence_no asc nulls first, created_at asc, id asc limit 2`)).rows;
  assert.deepEqual(limited, ordered.slice(0, 2).map(({ id, thread_id, sequence_no }) => ({ id, thread_id, sequence_no })));
  const failedQuestion = ordered.find((row) => row.thread_id === secondThread && row.sequence_no === 1);
  assert.equal(failedQuestion.role, "user");
  assert.equal(ordered.some((row) => row.thread_id === secondThread && row.role === "assistant"), false);
  report.ordering = { threadGrouped: true, sequencePrecedence: true, legacyStable: true, failedQuestionVisible: true, limitAfterOrder: true };
}

async function membershipChecks() {
  const ownerRequest = randomUUID();
  const ownerTurn = await claim({ actorId: ownerId, requestId: ownerRequest, question: "Private owner request" });
  for (const actorId of [adminId, outsiderId]) {
    await databaseQuery(`
      begin;
      set local role service_role;
      ${statusSelect({ actorId, requestId: ownerRequest, threadId: ownerTurn.resolved_thread_id })};
      commit;
    `, { expectError: /query returned no rows|Ask request is unavailable|Ask request identity conflict/ });
  }
  await databaseQuery(`
    begin;
    set local role service_role;
    ${statusSelect({ actorId: ownerId, requestId: ownerRequest, threadId: randomUUID() })};
    commit;
  `, { expectError: /Ask request identity conflict/ });

  const outsiderRequest = randomUUID();
  const outsiderTurn = await claim({ actorId: outsiderId, requestId: outsiderRequest, question: "Membership removal request" });
  await databaseQuery(`delete from public.workspace_memberships
    where workspace_id = ${uuid(outsiderWorkspaceId)} and user_id = ${uuid(outsiderId)}`);
  for (const lifecycleSql of [
    statusSelect({ actorId: outsiderId, requestId: outsiderRequest, threadId: outsiderTurn.resolved_thread_id }),
    retrySelect({ actorId: outsiderId, requestId: outsiderRequest, threadId: outsiderTurn.resolved_thread_id }),
    completeSelect({ actorId: outsiderId, requestId: outsiderRequest, token: outsiderTurn.attempt_token, generation: outsiderTurn.attempt_generation, answer: "Late private output" }),
    failSelect({ actorId: outsiderId, requestId: outsiderRequest, token: outsiderTurn.attempt_token, generation: outsiderTurn.attempt_generation }),
  ]) {
    await databaseQuery(`begin; set local role service_role; ${lifecycleSql}; commit;`, { expectError: /query returned no rows/ });
  }
  const deleted = one(await databaseQuery(`select
    (select count(*)::int from public.ask_threads where id = ${uuid(outsiderTurn.resolved_thread_id)}) as threads,
    (select count(*)::int from public.ask_turns where request_id = ${uuid(outsiderRequest)}) as turns,
    (select count(*)::int from public.ask_messages where thread_id = ${uuid(outsiderTurn.resolved_thread_id)}) as messages`));
  assert.deepEqual(deleted, { threads: 0, turns: 0, messages: 0 });
  report.membership = { crossWorkspaceDenied: true, sameWorkspaceAdminDenied: true, mismatchDenied: true, lateLifecycleDenied: true, cascadeRemovedConversation: true };
}

let primaryFailure = null;
let currentStage = "transport";
try {
  currentStage = "fixture setup";
  await createFixtures();
  if (requestedStage === "all" || requestedStage === "short-one") {
    currentStage = "transport";
    await transportProbe();
    currentStage = "same request races";
    await sameRequestRaces();
    currentStage = "same thread races";
    await sameThreadRaces();
    currentStage = "retry races";
    await retryRaces();
    currentStage = "independent thread races";
    await independentThreadRaces();
  }
  if (requestedStage === "all" || requestedStage === "short-two") {
    currentStage = "completion races";
    await completionRaces();
    currentStage = "recovery races";
    await recoveryRaces();
    currentStage = "atomicity and replay";
    await atomicityAndReplay();
    currentStage = "stale earlier turn";
    await staleEarlierTurn();
    currentStage = "ordering";
    await orderingChecks();
    currentStage = "membership";
    await membershipChecks();
  }
  if (requestedStage === "all" || requestedStage === "lease") {
    currentStage = "real lease expiry";
    await realLeaseExpiry();
  }
} catch (error) {
  primaryFailure = error;
} finally {
  try {
    await cleanupFixturesWithRetry();
    const remaining = one(await databaseQuery(`select
      (select count(*)::int from public.workspaces where id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)})) as workspaces,
      (select count(*)::int from auth.users where id in (${manifest.users.map(uuid).join(",")})) as users,
      (select count(*)::int from public.ask_threads where workspace_id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)})) as threads,
      (select count(*)::int from public.ask_turns where workspace_id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)})) as turns,
      (select count(*)::int from public.ask_messages where workspace_id in (${uuid(workspaceId)}, ${uuid(outsiderWorkspaceId)})) as messages,
      (select count(*)::int from pg_stat_activity where application_name like ${literal(`cl_ask_accept_${runId.slice(0, 8)}%`)}) as sessions`));
    assert.deepEqual(remaining, { workspaces: 0, users: 0, threads: 0, turns: 0, messages: 0, sessions: 0 });
    report.cleanup = { exactFixturesRemoved: true, sessionsRemaining: 0 };
  } catch (cleanupError) {
    primaryFailure ??= cleanupError;
  }
}

if (primaryFailure) {
  console.error(`ASK_ACCEPTANCE=FAIL stage=${currentStage} ${primaryFailure instanceof Error ? primaryFailure.message : "unknown failure"}`);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ASK_ACCEPTANCE: "PASS", stage: requestedStage, ...report }, null, 2));
}
apiAgent.destroy();
