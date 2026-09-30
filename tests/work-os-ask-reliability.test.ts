import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createAskClientSubmission,
  performAskClientSubmission,
  shouldApplyAskResult,
} from "../lib/ask-client-submission";
import {
  AskReliabilityError,
  readReliableAskStatus,
  runReliableAskSubmission,
  type AskFailureCategory,
  type AskSubmissionResult,
  type AskTurnClaim,
  type AskTurnStore,
} from "../lib/ask-reliability";
import type { AskGroundedResponse } from "../lib/ask-core";

const requestA = "00000000-0000-4000-8000-000000000101";
const requestB = "00000000-0000-4000-8000-000000000102";
const threadA = "00000000-0000-4000-8000-000000000201";
const threadB = "00000000-0000-4000-8000-000000000202";
const sentinelAttemptToken = "90000000-0000-4000-8000-000000000999";

type MemoryTurn = {
  turnId: string;
  requestId: string;
  threadId: string;
  question: string;
  state: "processing" | "completed" | "failed";
  sequence: number;
  generation: number;
  token: string | null;
  leaseUntil: number | null;
  failure: AskFailureCategory | null;
  response: AskGroundedResponse | null;
};

function answer(text = "Stored answer"): AskGroundedResponse {
  return {
    answer: text,
    metadata: { version: 1, responseType: "answer", clarificationRequired: false, references: [] },
  };
}

class MemoryAskStore implements AskTurnStore {
  readonly turns = new Map<string, MemoryTurn>();
  readonly threads = new Set<string>([threadA, threadB]);
  readonly userMessages: Array<{ requestId: string; threadId: string; question: string }> = [];
  readonly assistantMessages: Array<{ requestId: string; response: AskGroundedResponse }> = [];
  now = 1_000;
  nextThread = 300;
  nextTurn = 400;
  nextToken = 500;
  member = true;
  commitThenThrow = false;
  throwBeforeCommit = false;
  forcedAttemptToken: string | null = null;
  historyError = false;
  readonly completedWithTokens: string[] = [];
  readonly failedWithTokens: string[] = [];

  private issueToken() {
    return this.forcedAttemptToken
      ?? `00000000-0000-4000-8000-${String(this.nextToken++).padStart(12, "0")}`;
  }

  private expire(turn: MemoryTurn) {
    if (turn.state === "processing" && turn.leaseUntil !== null && turn.leaseUntil <= this.now) {
      turn.state = "failed";
      turn.failure = "interrupted";
      turn.token = null;
      turn.leaseUntil = null;
    }
  }

  private claimView(turn: MemoryTurn, disposition: AskTurnClaim["disposition"] = turn.state): AskTurnClaim {
    return {
      disposition,
      turnId: turn.turnId,
      threadId: turn.threadId,
      requestId: turn.requestId,
      question: turn.question,
      turnSequence: turn.sequence,
      userSequenceNo: turn.sequence * 2 - 1,
      attemptToken: disposition === "claimed" ? turn.token : null,
      attemptGeneration: turn.generation,
      failureCategory: turn.failure,
      response: turn.response,
    };
  }

  private owned() {
    if (!this.member) throw new AskReliabilityError("DENIED");
  }

  async claim(input: { requestId: string; threadId?: string; question: string; title: string; leaseSeconds: number }) {
    this.owned();
    const existing = this.turns.get(input.requestId);
    if (existing) {
      if (existing.question !== input.question || (input.threadId && input.threadId !== existing.threadId)) {
        throw new AskReliabilityError("CONFLICT");
      }
      this.expire(existing);
      return this.claimView(existing);
    }
    const threadId = input.threadId ?? `00000000-0000-4000-8000-${String(this.nextThread++).padStart(12, "0")}`;
    if (!this.threads.has(threadId) && input.threadId) throw new AskReliabilityError("DENIED");
    const active = [...this.turns.values()].find((turn) => turn.threadId === threadId && turn.state === "processing");
    if (active) {
      this.expire(active);
      if (active.state === "processing") {
        return {
          disposition: "busy", turnId: null, threadId, requestId: input.requestId,
          question: input.question, turnSequence: null, userSequenceNo: null,
          attemptToken: null, attemptGeneration: null, failureCategory: null, response: null,
        } satisfies AskTurnClaim;
      }
    }
    this.threads.add(threadId);
    const sequence = [...this.turns.values()].filter((turn) => turn.threadId === threadId).length + 1;
    const turn: MemoryTurn = {
      turnId: `00000000-0000-4000-8000-${String(this.nextTurn++).padStart(12, "0")}`,
      requestId: input.requestId,
      threadId,
      question: input.question,
      state: "processing",
      sequence,
      generation: 1,
      token: this.issueToken(),
      leaseUntil: this.now + input.leaseSeconds,
      failure: null,
      response: null,
    };
    this.turns.set(turn.requestId, turn);
    this.userMessages.push({ requestId: turn.requestId, threadId, question: turn.question });
    return this.claimView(turn, "claimed");
  }

  async retry(input: { requestId: string; threadId?: string; leaseSeconds: number }) {
    this.owned();
    const turn = this.turns.get(input.requestId);
    if (!turn || (input.threadId && input.threadId !== turn.threadId)) throw new AskReliabilityError("DENIED");
    this.expire(turn);
    if (turn.state !== "failed") return this.claimView(turn);
    const latest = Math.max(...[...this.turns.values()].filter((item) => item.threadId === turn.threadId).map((item) => item.sequence));
    if (latest !== turn.sequence) throw new AskReliabilityError("CONFLICT");
    turn.state = "processing";
    turn.generation += 1;
    turn.token = this.issueToken();
    turn.leaseUntil = this.now + input.leaseSeconds;
    turn.failure = null;
    return this.claimView(turn, "claimed");
  }

  async status(input: { requestId: string; threadId?: string }) {
    this.owned();
    const turn = this.turns.get(input.requestId);
    if (!turn || (input.threadId && input.threadId !== turn.threadId)) throw new AskReliabilityError("DENIED");
    this.expire(turn);
    return this.claimView(turn);
  }

  async loadHistory() {
    if (this.historyError) throw new Error("retrieval unavailable");
    return [];
  }

  async complete(input: { requestId: string; attemptToken: string; attemptGeneration: number; response: AskGroundedResponse }) {
    this.owned();
    this.completedWithTokens.push(input.attemptToken);
    if (this.throwBeforeCommit) throw new Error("database unavailable");
    const turn = this.turns.get(input.requestId);
    if (!turn || turn.state !== "processing" || turn.token !== input.attemptToken
      || turn.generation !== input.attemptGeneration || (turn.leaseUntil ?? 0) <= this.now) return false;
    turn.state = "completed";
    turn.token = null;
    turn.leaseUntil = null;
    turn.response = input.response;
    this.assistantMessages.push({ requestId: turn.requestId, response: input.response });
    if (this.commitThenThrow) {
      this.commitThenThrow = false;
      throw new Error("response lost after commit");
    }
    return true;
  }

  async fail(input: { requestId: string; attemptToken: string; attemptGeneration: number; category: AskFailureCategory }) {
    this.owned();
    this.failedWithTokens.push(input.attemptToken);
    const turn = this.turns.get(input.requestId);
    if (!turn || turn.state !== "processing" || turn.token !== input.attemptToken
      || turn.generation !== input.attemptGeneration) return false;
    turn.state = "failed";
    turn.token = null;
    turn.leaseUntil = null;
    turn.failure = input.category;
    return true;
  }
}

function execute(
  store: MemoryAskStore,
  input: { requestId: string; threadId?: string; question?: string; mode?: "submit" | "retry" },
  generate: () => Promise<AskGroundedResponse> = async () => answer(),
) {
  return runReliableAskSubmission({
    mode: input.mode ?? "submit",
    requestId: input.requestId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    question: input.question ?? "What needs me?",
    title: "What needs me?",
  }, {
    store,
    generate,
    classifyFailure: () => "generation_failed",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("same first-message request is one thread, one user message, and completed replay skips generation", async () => {
  const store = new MemoryAskStore();
  let modelCalls = 0;
  const first = await execute(store, { requestId: requestA }, async () => { modelCalls += 1; return answer("First"); });
  const replay = await execute(store, { requestId: requestA }, async () => { modelCalls += 1; return answer("Duplicate"); });
  const resolvedReplay = await execute(store, { requestId: requestA, threadId: first.threadId! }, async () => { modelCalls += 1; return answer("Duplicate"); });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(first.threadId, replay.threadId);
  assert.equal(resolvedReplay.threadId, first.threadId);
  assert.equal(store.threads.size, 3);
  assert.equal(store.userMessages.length, 1);
  assert.equal(store.assistantMessages.length, 1);
  assert.equal(modelCalls, 1);
});

test("request identity cannot change question or bind to another thread", async () => {
  const store = new MemoryAskStore();
  const first = await execute(store, { requestId: requestA });
  await assert.rejects(() => execute(store, { requestId: requestA, question: "Changed" }), /CONFLICT/);
  await assert.rejects(() => execute(store, { requestId: requestA, threadId: threadB }), /CONFLICT/);
  assert.equal(first.threadId !== null, true);
  assert.equal(store.userMessages.length, 1);
});

test("same text with a new deliberate request ID creates a separate ordered turn", async () => {
  const store = new MemoryAskStore();
  await execute(store, { requestId: requestA, threadId: threadA, question: "Same question" });
  await execute(store, { requestId: requestB, threadId: threadA, question: "Same question" });
  assert.equal(store.userMessages.length, 2);
  assert.deepEqual([...store.turns.values()].map((turn) => turn.sequence), [1, 2]);
  assert.equal(store.assistantMessages.length, 2);
});

test("processing replay and competing question in one thread cannot start another attempt", async () => {
  const store = new MemoryAskStore();
  const gate = deferred<AskGroundedResponse>();
  let calls = 0;
  const first = execute(store, { requestId: requestA, threadId: threadA }, () => { calls += 1; return gate.promise; });
  await new Promise((resolve) => setImmediate(resolve));
  const replay = await execute(store, { requestId: requestA, threadId: threadA }, async () => { calls += 1; return answer(); });
  const busy = await execute(store, { requestId: requestB, threadId: threadA }, async () => { calls += 1; return answer(); });
  assert.equal(replay.outcome, "processing");
  assert.equal(busy.outcome, "busy");
  assert.equal(busy.messageSaved, false);
  assert.equal(store.userMessages.length, 1);
  assert.equal(calls, 1);
  gate.resolve(answer());
  await first;
});

test("independent conversations can proceed without a global thread lock", async () => {
  const store = new MemoryAskStore();
  const gate = deferred<AskGroundedResponse>();
  const first = execute(store, { requestId: requestA, threadId: threadA }, () => gate.promise);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await execute(store, { requestId: requestB, threadId: threadB });
  assert.equal(second.outcome, "completed");
  gate.resolve(answer());
  await first;
});

test("generation failure preserves one question and explicit retry reuses it", async () => {
  const store = new MemoryAskStore();
  const failed = await execute(store, { requestId: requestA, threadId: threadA }, async () => { throw new Error("provider"); });
  const retried = await execute(store, { requestId: requestA, threadId: threadA, mode: "retry", question: "" });
  assert.equal(failed.outcome, "failed");
  assert.equal(retried.outcome, "completed");
  assert.equal(store.userMessages.length, 1);
  assert.equal(store.userMessages[0].question, "What needs me?");
  assert.equal(store.assistantMessages.length, 1);
});

test("provider and retrieval failures both persist an observable terminal failure", async () => {
  const provider = new MemoryAskStore();
  const providerResult = await execute(provider, { requestId: requestA, threadId: threadA }, async () => {
    throw new Error("provider unavailable");
  });
  const providerTurn = provider.turns.get(requestA);
  assert.equal(providerResult.outcome, "failed");
  assert.equal(providerResult.retryable, true);
  assert.equal(providerTurn?.state, "failed");
  assert.equal(providerTurn?.failure, "generation_failed");
  assert.equal(providerTurn?.token, null);
  assert.equal(providerTurn?.leaseUntil, null);
  assert.equal(provider.assistantMessages.length, 0);

  const retrieval = new MemoryAskStore();
  retrieval.historyError = true;
  let providerCalls = 0;
  const retrievalResult = await execute(retrieval, { requestId: requestB, threadId: threadB }, async () => {
    providerCalls += 1;
    return answer();
  });
  const retrievalTurn = retrieval.turns.get(requestB);
  assert.equal(retrievalResult.outcome, "failed");
  assert.equal(retrievalResult.retryable, true);
  assert.equal(retrievalTurn?.state, "failed");
  assert.equal(retrievalTurn?.failure, "generation_failed");
  assert.equal(retrievalTurn?.token, null);
  assert.equal(retrievalTurn?.leaseUntil, null);
  assert.equal(retrieval.assistantMessages.length, 0);
  assert.equal(providerCalls, 0);
});

test("concurrent explicit retries have one winning generation", async () => {
  const store = new MemoryAskStore();
  await execute(store, { requestId: requestA, threadId: threadA }, async () => { throw new Error("provider"); });
  const gate = deferred<AskGroundedResponse>();
  let calls = 0;
  const first = execute(store, { requestId: requestA, threadId: threadA, mode: "retry", question: "" }, () => { calls += 1; return gate.promise; });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await execute(store, { requestId: requestA, threadId: threadA, mode: "retry", question: "" }, async () => { calls += 1; return answer(); });
  assert.equal(second.outcome, "processing");
  assert.equal(calls, 1);
  gate.resolve(answer());
  await first;
  assert.equal(store.assistantMessages.length, 1);
});

test("a failed old turn cannot be retried after a later turn establishes ordering", async () => {
  const store = new MemoryAskStore();
  await execute(store, { requestId: requestA, threadId: threadA }, async () => { throw new Error("provider"); });
  await execute(store, { requestId: requestB, threadId: threadA });
  await assert.rejects(
    () => execute(store, { requestId: requestA, threadId: threadA, mode: "retry", question: "" }),
    /CONFLICT/,
  );
  assert.equal(store.assistantMessages.length, 1);
});

test("abandoned lease is recoverable and stale completion/failure cannot affect the retry", async () => {
  const store = new MemoryAskStore();
  const initial = await store.claim({ requestId: requestA, threadId: threadA, question: "Question", title: "Question", leaseSeconds: 90 });
  assert.equal(initial.disposition, "claimed");
  store.now += 91;
  const expired = await store.status({ requestId: requestA, threadId: threadA });
  assert.equal(expired.disposition, "failed");
  const retry = await store.retry({ requestId: requestA, threadId: threadA, leaseSeconds: 90 });
  assert.equal(retry.disposition, "claimed");
  assert.notEqual(retry.attemptToken, initial.attemptToken);
  assert.equal(await store.complete({ requestId: requestA, attemptToken: initial.attemptToken!, attemptGeneration: initial.attemptGeneration!, response: answer("Late") }), false);
  assert.equal(await store.fail({ requestId: requestA, attemptToken: initial.attemptToken!, attemptGeneration: initial.attemptGeneration!, category: "generation_failed" }), false);
  assert.equal(await store.complete({ requestId: requestA, attemptToken: retry.attemptToken!, attemptGeneration: retry.attemptGeneration!, response: answer("Current") }), true);
  assert.equal(store.assistantMessages.length, 1);
  assert.equal(store.assistantMessages[0].response.answer, "Current");
});

test("lost response after atomic commit replays success; pre-commit failure stays processing", async () => {
  const committed = new MemoryAskStore();
  committed.commitThenThrow = true;
  const recovered = await execute(committed, { requestId: requestA, threadId: threadA });
  assert.equal(recovered.outcome, "completed");
  assert.equal(recovered.replayed, true);
  assert.equal(committed.assistantMessages.length, 1);

  const unavailable = new MemoryAskStore();
  unavailable.throwBeforeCommit = true;
  const uncertain = await execute(unavailable, { requestId: requestA, threadId: threadA });
  assert.equal(uncertain.outcome, "processing");
  assert.equal(unavailable.assistantMessages.length, 0);
  assert.equal(unavailable.turns.get(requestA)?.state, "processing");
});

test("membership removal during generation prevents finalization and private result recovery", async () => {
  const store = new MemoryAskStore();
  await assert.rejects(() => execute(store, { requestId: requestA, threadId: threadA }, async () => {
    store.member = false;
    return answer("Must not persist");
  }), /DENIED/);
  assert.equal(store.assistantMessages.length, 0);
});

test("client transport retry keeps the opaque ID and late navigation cannot apply a response", async () => {
  const pending = createAskClientSubmission("Draft question", threadA, () => requestA);
  const network = await performAskClientSubmission(pending, async () => { throw new Error("offline"); });
  assert.equal(network.kind, "network_error");
  if (network.kind === "network_error") assert.equal(network.pending.requestId, requestA);
  const captured: string[] = [];
  const completed: AskSubmissionResult = {
    ok: true, requestId: requestA, threadId: threadA, outcome: "completed",
    messageSaved: true, replayed: true, retryable: false, response: answer(),
  };
  await performAskClientSubmission(pending, async (input) => { captured.push(input.requestId); return completed; });
  assert.deepEqual(captured, [requestA]);
  assert.equal(shouldApplyAskResult(pending, threadA, completed), true);
  assert.equal(shouldApplyAskResult(pending, threadB, completed), false);
});

test("deterministic empty and unsupported answers use the same durable completion path", async () => {
  const emptyStore = new MemoryAskStore();
  const empty = await execute(emptyStore, { requestId: requestA, threadId: threadA }, async () => answer("Nothing needs you right now."));
  assert.equal(empty.outcome, "completed");
  assert.equal(emptyStore.userMessages.length, 1);
  assert.equal(emptyStore.assistantMessages.length, 1);

  const unsupportedStore = new MemoryAskStore();
  const unsupported = await execute(unsupportedStore, { requestId: requestB, threadId: threadB }, async () => ({
    answer: "That external action is not enabled for Ask.",
    metadata: {
      version: 1, responseType: "unsupported", clarificationRequired: false,
      references: [], unsupportedReason: "External actions are disabled.",
    },
  }));
  assert.equal(unsupported.outcome, "completed");
  assert.equal(unsupportedStore.assistantMessages.length, 1);
});

test("attempt token stays inside lifecycle processing and never enters public status, replay, retry, or error results", async () => {
  const store = new MemoryAskStore();
  store.forcedAttemptToken = sentinelAttemptToken;

  const completed = await execute(store, { requestId: requestA, threadId: threadA });
  assert.deepEqual(store.completedWithTokens, [sentinelAttemptToken]);

  const replay = await execute(store, { requestId: requestA, threadId: threadA });
  const status = await readReliableAskStatus({ requestId: requestA, threadId: threadA }, store);
  for (const result of [completed, replay, status]) {
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(sentinelAttemptToken));
    assert.doesNotMatch(serialized, /attempt_token|attemptToken|attempt_generation|attemptGeneration|lease_until|leaseUntil/);
  }

  const failing = new MemoryAskStore();
  failing.forcedAttemptToken = sentinelAttemptToken;
  const failed = await execute(
    failing,
    { requestId: requestB, threadId: threadB },
    async () => { throw new Error(`provider failure ${sentinelAttemptToken}`); },
  );
  assert.deepEqual(failing.failedWithTokens, [sentinelAttemptToken]);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(sentinelAttemptToken));
  assert.doesNotMatch(JSON.stringify(failed), /attempt_token|attemptToken|attempt_generation|attemptGeneration|lease_until|leaseUntil/);

  const retried = await execute(failing, {
    requestId: requestB,
    threadId: threadB,
    mode: "retry",
    question: "",
  });
  assert.equal(retried.outcome, "completed");
  assert.doesNotMatch(JSON.stringify(retried), new RegExp(sentinelAttemptToken));
  assert.equal(failing.completedWithTokens.at(-1), sentinelAttemptToken);
});

test("migration and application preserve atomicity, ownership, RLS, export, and read-only product scope", async () => {
  const [sql, privacySql, service, action, page, view, exportRoute, dbAcceptance] = await Promise.all([
    readFile("supabase/migrations/20260928084305_work_os_ask_submission_reliability.sql", "utf8"),
    readFile("supabase/migrations/20260928134101_work_os_ask_attempt_token_privacy.sql", "utf8"),
    readFile("lib/ask.ts", "utf8"),
    readFile("app/actions/ask.ts", "utf8"),
    readFile("app/ask/page.tsx", "utf8"),
    readFile("components/ask/ask-view.tsx", "utf8"),
    readFile("app/settings/export/route.ts", "utf8"),
    readFile("supabase/tests/work_os_ask_reliability.sql", "utf8"),
  ]);
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /ask_turns_request_unique unique \(workspace_id, user_id, request_id\)/);
  assert.match(sql, /ask_turns_one_processing_per_thread_idx[\s\S]*where state = 'processing'/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /attempt_token <> p_attempt_token/);
  assert.match(sql, /attempt_generation <> p_attempt_generation/);
  assert.match(sql, /lease_until <= clock_timestamp\(\)/);
  assert.match(sql, /insert into public\.ask_messages[\s\S]*update public\.ask_turns[\s\S]*update public\.ask_threads/);
  assert.match(sql, /security invoker set search_path = ''/g);
  assert.match(sql, /revoke all on function public\.claim_ask_turn[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /ask_turns_owner_select[\s\S]*user_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /membership\.is_default/);
  assert.match(privacySql, /^begin;/);
  assert.match(privacySql, /revoke select on table public\.ask_turns from public, anon, authenticated/);
  assert.match(privacySql, /grant select \(\s*workspace_id,\s*user_id,\s*request_id,\s*thread_id,\s*state,\s*failure_category\s*\) on table public\.ask_turns to authenticated/);
  assert.doesNotMatch(privacySql, /grant select[\s\S]*attempt_token|grant select[\s\S]*attempt_generation|grant select[\s\S]*lease_until/);
  assert.match(privacySql, /commit;\s*$/);
  assert.match(service, /enforceRateLimit\("ask-status"/);
  assert.match(service, /enforceUsageQuota\(auth\.user\.id, "ai_generations"\)/);
  assert.match(service, /\.select\("request_id,thread_id,state,failure_category"\)/);
  assert.doesNotMatch(service, /\.select\("[^"]*attempt_token|\.select\("[^"]*attempt_generation|\.select\("[^"]*lease_until/);
  assert.doesNotMatch(service, /securityLog\([^;]*(?:attempt_token|attemptToken|attempt_generation|attemptGeneration|lease_until|leaseUntil)/);
  assert.doesNotMatch(service, /return .*error\.message/);
  assert.match(page, /<AskView[\s\S]*data=\{data\}/);
  assert.doesNotMatch(page, /attempt_token|attemptToken|attempt_generation|attemptGeneration|lease_until|leaseUntil/);
  assert.match(view, /submittingRef\.current/);
  assert.match(view, /try \{/);
  assert.match(view, /finally \{/);
  assert.doesNotMatch(view, /localStorage|sessionStorage/);
  assert.doesNotMatch(action, /transitionCurrentUserWorkItem|decideCurrentUserApproval|executeWorkflow/);
  assert.doesNotMatch(action, /attempt_token|attemptToken|attempt_generation|attemptGeneration|lease_until|leaseUntil/);
  assert.match(exportRoute, /askTurns: askTurnResult\.data/);
  assert.doesNotMatch(exportRoute, /\.select\("[^"]*attempt_token|\.select\("[^"]*attempt_generation|\.select\("[^"]*lease_until/);
  assert.match(dbAcceptance, /claim_ask_turn/);
  assert.match(dbAcceptance, /complete_ask_turn/);
  assert.match(dbAcceptance, /rollback/i);
});
