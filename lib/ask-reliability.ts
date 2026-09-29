import type { AskGroundedResponse, AskHistoryMessage } from "@/lib/ask-core";

export const ASK_TURN_LEASE_SECONDS = 90;

export type AskFailureCategory =
  | "generation_failed"
  | "rate_limited"
  | "quota_exceeded"
  | "capacity_busy"
  | "persistence_failed"
  | "interrupted"
  | "authorization_lost"
  | "unavailable";

export type AskSubmissionOutcome =
  | "completed"
  | "processing"
  | "failed"
  | "busy"
  | "rejected"
  | "uncertain";

export type AskSubmissionResult = {
  ok: boolean;
  requestId: string | null;
  threadId: string | null;
  outcome: AskSubmissionOutcome;
  messageSaved: boolean | null;
  replayed: boolean;
  retryable: boolean;
  response?: AskGroundedResponse;
  error?: string;
};

export type AskTurnClaim = {
  disposition: "claimed" | "completed" | "processing" | "failed" | "busy";
  turnId: string | null;
  threadId: string;
  requestId: string;
  question: string;
  turnSequence: number | null;
  userSequenceNo: number | null;
  attemptToken: string | null;
  attemptGeneration: number | null;
  failureCategory: AskFailureCategory | null;
  response: AskGroundedResponse | null;
};

export type AskTurnStore = {
  claim(input: { requestId: string; threadId?: string; question: string; title: string; leaseSeconds: number }): Promise<AskTurnClaim>;
  retry(input: { requestId: string; threadId?: string; leaseSeconds: number }): Promise<AskTurnClaim>;
  status(input: { requestId: string; threadId?: string }): Promise<AskTurnClaim>;
  loadHistory(input: { threadId: string; turnId: string; userSequenceNo: number }): Promise<AskHistoryMessage[]>;
  complete(input: {
    requestId: string;
    attemptToken: string;
    attemptGeneration: number;
    response: AskGroundedResponse;
  }): Promise<boolean>;
  fail(input: {
    requestId: string;
    attemptToken: string;
    attemptGeneration: number;
    category: AskFailureCategory;
  }): Promise<boolean>;
};

export class AskReliabilityError extends Error {
  constructor(public readonly code: "CONFLICT" | "DENIED" | "UNAVAILABLE") {
    super(code);
    this.name = "AskReliabilityError";
  }
}

function failedMessage(category: AskFailureCategory | null): string {
  if (category === "interrupted") {
    return "Your question was saved, but the previous attempt was interrupted. You can retry it safely.";
  }
  if (category === "rate_limited") {
    return "Your question was saved, but the request limit was reached before an answer was generated. Try again shortly.";
  }
  if (category === "quota_exceeded") {
    return "Your question was saved, but the current AI usage limit has been reached.";
  }
  if (category === "capacity_busy") {
    return "Your question was saved, but Ask CrazyLoops was at capacity. You can retry it safely.";
  }
  if (category === "authorization_lost") {
    return "Your question was saved, but your workspace access changed before the answer could be stored.";
  }
  return "Your question was saved, but CrazyLoops could not generate an answer. You can retry it safely.";
}

function resultFromClaim(claim: AskTurnClaim, replayed: boolean): AskSubmissionResult {
  if (claim.disposition === "completed" && claim.response) {
    return {
      ok: true,
      requestId: claim.requestId,
      threadId: claim.threadId,
      outcome: "completed",
      messageSaved: true,
      replayed,
      retryable: false,
      response: claim.response,
    };
  }
  if (claim.disposition === "processing") {
    return {
      ok: false,
      requestId: claim.requestId,
      threadId: claim.threadId,
      outcome: "processing",
      messageSaved: true,
      replayed,
      retryable: false,
      error: "Your question is still processing. Check its status again shortly.",
    };
  }
  if (claim.disposition === "failed") {
    return {
      ok: false,
      requestId: claim.requestId,
      threadId: claim.threadId,
      outcome: "failed",
      messageSaved: true,
      replayed,
      retryable: true,
      error: failedMessage(claim.failureCategory),
    };
  }
  if (claim.disposition === "busy") {
    return {
      ok: false,
      requestId: claim.requestId,
      threadId: claim.threadId,
      outcome: "busy",
      messageSaved: false,
      replayed,
      retryable: false,
      error: "This conversation is already answering another question. Your new message was not saved.",
    };
  }
  throw new AskReliabilityError("UNAVAILABLE");
}

async function reconcile(
  store: AskTurnStore,
  input: { requestId: string; threadId?: string },
): Promise<AskSubmissionResult> {
  try {
    return resultFromClaim(await store.status(input), true);
  } catch (error) {
    if (error instanceof AskReliabilityError && error.code !== "UNAVAILABLE") throw error;
    return {
      ok: false,
      requestId: input.requestId,
      threadId: input.threadId ?? null,
      outcome: "uncertain",
      messageSaved: null,
      replayed: false,
      retryable: false,
      error: "CrazyLoops could not confirm the result. Keep this page open and check the saved status before submitting again.",
    };
  }
}

export async function runReliableAskSubmission(input: {
  mode: "submit" | "retry";
  requestId: string;
  threadId?: string;
  question: string;
  title: string;
}, dependencies: {
  store: AskTurnStore;
  generate(input: { question: string; history: AskHistoryMessage[] }): Promise<AskGroundedResponse>;
  classifyFailure(error: unknown): AskFailureCategory;
}): Promise<AskSubmissionResult> {
  let claim: AskTurnClaim;
  try {
    claim = input.mode === "retry"
      ? await dependencies.store.retry({
        requestId: input.requestId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        leaseSeconds: ASK_TURN_LEASE_SECONDS,
      })
      : await dependencies.store.claim({
        requestId: input.requestId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        question: input.question,
        title: input.title,
        leaseSeconds: ASK_TURN_LEASE_SECONDS,
      });
  } catch (error) {
    if (error instanceof AskReliabilityError && error.code !== "UNAVAILABLE") throw error;
    return reconcile(dependencies.store, {
      requestId: input.requestId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    });
  }

  if (claim.disposition !== "claimed") return resultFromClaim(claim, true);
  if (!claim.turnId || !claim.attemptToken || claim.attemptGeneration === null || claim.userSequenceNo === null) {
    throw new AskReliabilityError("UNAVAILABLE");
  }

  let response: AskGroundedResponse;
  try {
    const history = await dependencies.store.loadHistory({
      threadId: claim.threadId,
      turnId: claim.turnId,
      userSequenceNo: claim.userSequenceNo,
    });
    response = await dependencies.generate({ question: claim.question, history });
  } catch (error) {
    const category = dependencies.classifyFailure(error);
    try {
      const failed = await dependencies.store.fail({
        requestId: claim.requestId,
        attemptToken: claim.attemptToken,
        attemptGeneration: claim.attemptGeneration,
        category,
      });
      if (!failed) return reconcile(dependencies.store, { requestId: claim.requestId, threadId: claim.threadId });
    } catch {
      return reconcile(dependencies.store, { requestId: claim.requestId, threadId: claim.threadId });
    }
    return resultFromClaim({ ...claim, disposition: "failed", failureCategory: category }, false);
  }

  try {
    const completed = await dependencies.store.complete({
      requestId: claim.requestId,
      attemptToken: claim.attemptToken,
      attemptGeneration: claim.attemptGeneration,
      response,
    });
    if (!completed) return reconcile(dependencies.store, { requestId: claim.requestId, threadId: claim.threadId });
    return {
      ok: true,
      requestId: claim.requestId,
      threadId: claim.threadId,
      outcome: "completed",
      messageSaved: true,
      replayed: false,
      retryable: false,
      response,
    };
  } catch {
    return reconcile(dependencies.store, { requestId: claim.requestId, threadId: claim.threadId });
  }
}

export async function readReliableAskStatus(
  input: { requestId: string; threadId?: string },
  store: AskTurnStore,
): Promise<AskSubmissionResult> {
  return reconcile(store, input);
}
