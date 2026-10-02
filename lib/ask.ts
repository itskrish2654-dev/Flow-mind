import "server-only";

import { z } from "zod";

import {
  ASK_LIMITS,
  AskInputSchema,
  AskRequestReferenceSchema,
  AskResponseMetadataSchema,
  deterministicThreadTitle,
  isAskActionOutcomeQuestion,
  selectAskTools,
  runGroundedAsk,
  unsupportedAskResponse,
  type AskGroundedResponse,
  type AskHistoryMessage,
  type AskResponseMetadata,
} from "@/lib/ask-core";
import { callAskModel } from "@/lib/ask-model";
import { planAskAction } from "@/lib/ask-action-planner";
import {
  AskReliabilityError,
  readReliableAskStatus,
  runReliableAskSubmission,
  type AskFailureCategory,
  type AskSubmissionResult,
  type AskTurnClaim,
  type AskTurnStore,
} from "@/lib/ask-reliability";
import { executeAskTool } from "@/lib/ask-tools";
import { getAuthenticatedContext } from "@/lib/auth";
import { CAPABILITY_REGISTRY, getCapability } from "@/lib/capability-registry";
import {
  SECURITY_LIMITS,
  SecurityGateError,
  enforceRateLimit,
  enforceUsageQuota,
  withConcurrencyLease,
} from "@/lib/security/limits";
import { securityLog } from "@/lib/security/redaction";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

type AskThreadRow = Database["public"]["Tables"]["ask_threads"]["Row"];
type AskMessageRow = Database["public"]["Tables"]["ask_messages"]["Row"];
type AskTurnRow = Database["public"]["Tables"]["ask_turns"]["Row"];
type AuthContext = NonNullable<Awaited<ReturnType<typeof getAuthenticatedContext>>>;

export type AskThreadDto = Pick<AskThreadRow, "id" | "title" | "created_at" | "updated_at">;
export type AskMessageDto = Pick<AskMessageRow, "id" | "role" | "content" | "created_at"> & {
  metadata: AskResponseMetadata | null;
};
export type AskPendingDto = Pick<AskTurnRow, "request_id" | "thread_id" | "state" | "failure_category">;
export type AskPageData = {
  threads: AskThreadDto[];
  selectedThread: AskThreadDto | null;
  messages: AskMessageDto[];
  pendingSubmission: AskPendingDto | null;
  requestedSubmissionId: string | null;
  unavailable: boolean;
};
export type SendAskResult = AskSubmissionResult;

type AskRpcRow = {
  disposition: string;
  turn_id: string | null;
  resolved_thread_id: string;
  logical_request_id: string;
  submitted_question: string;
  turn_sequence: number | null;
  user_sequence_no: number | null;
  attempt_token: string | null;
  attempt_generation: number | null;
  turn_state: string | null;
  failure_category: string | null;
  assistant_content: string | null;
  assistant_metadata: Json | null;
};

const LIKELY_SECRET = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:gsk|sk|sb_secret)_[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/i;
const CLAIM_DISPOSITIONS = new Set(["claimed", "completed", "processing", "failed", "busy"]);
const FAILURE_CATEGORIES = new Set<AskFailureCategory>([
  "generation_failed", "rate_limited", "quota_exceeded", "capacity_busy",
  "persistence_failed", "interrupted", "authorization_lost", "unavailable",
]);

function safeMetadata(value: Json | null): AskResponseMetadata | null {
  const parsed = AskResponseMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function messageDto(row: AskMessageRow): AskMessageDto {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    metadata: row.role === "assistant" ? safeMetadata(row.response_metadata) : null,
  };
}

function compareMessages(left: AskMessageRow, right: AskMessageRow): number {
  if (left.sequence_no !== null && right.sequence_no !== null) return left.sequence_no - right.sequence_no;
  if (left.sequence_no === null && right.sequence_no !== null) return -1;
  if (left.sequence_no !== null && right.sequence_no === null) return 1;
  const time = left.created_at.localeCompare(right.created_at);
  return time || left.id.localeCompare(right.id);
}

export async function loadAskPageData(threadId?: string, requestId?: string): Promise<AskPageData | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;
  const { data: threads, error: threadError } = await auth.supabase.from("ask_threads")
    .select("id,title,created_at,updated_at")
    .eq("workspace_id", auth.workspace.id)
    .eq("user_id", auth.user.id)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(ASK_LIMITS.threads);
  if (threadError) return { threads: [], selectedThread: null, messages: [], pendingSubmission: null, requestedSubmissionId: null, unavailable: true };

  const parsedThreadId = threadId ? z.uuid().safeParse(threadId) : null;
  const parsedRequestId = requestId ? z.uuid().safeParse(requestId) : null;
  if ((threadId && !parsedThreadId?.success) || (requestId && !parsedRequestId?.success)) {
    return { threads, selectedThread: null, messages: [], pendingSubmission: null, requestedSubmissionId: null, unavailable: true };
  }
  const requestedSubmissionId = parsedRequestId?.success ? parsedRequestId.data : null;

  let pendingSubmission: AskPendingDto | null = null;
  if (parsedRequestId?.success) {
    const { data: turn, error: turnError } = await auth.supabase.from("ask_turns")
      .select("request_id,thread_id,state,failure_category")
      .eq("workspace_id", auth.workspace.id)
      .eq("user_id", auth.user.id)
      .eq("request_id", parsedRequestId.data)
      .maybeSingle();
    if (turnError) return { threads, selectedThread: null, messages: [], pendingSubmission: null, requestedSubmissionId, unavailable: true };
    pendingSubmission = turn;
  }

  const selectedId = parsedThreadId?.success ? parsedThreadId.data : pendingSubmission?.thread_id;
  if (parsedThreadId?.success && pendingSubmission && pendingSubmission.thread_id !== parsedThreadId.data) {
    return { threads, selectedThread: null, messages: [], pendingSubmission: null, requestedSubmissionId, unavailable: true };
  }
  const selectedThread = selectedId ? threads.find((thread) => thread.id === selectedId) ?? null : null;
  if (selectedId && !selectedThread) {
    return { threads, selectedThread: null, messages: [], pendingSubmission: null, requestedSubmissionId, unavailable: true };
  }
  if (!selectedThread) return { threads, selectedThread: null, messages: [], pendingSubmission, requestedSubmissionId, unavailable: false };

  const { data: storedMessages, error: messageError } = await auth.supabase.from("ask_messages")
    .select("id,thread_id,workspace_id,user_id,role,content,response_metadata,created_at,turn_id,turn_position,sequence_no")
    .eq("thread_id", selectedThread.id)
    .eq("workspace_id", auth.workspace.id)
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ASK_LIMITS.messages);
  if (messageError) return { threads, selectedThread, messages: [], pendingSubmission, requestedSubmissionId, unavailable: true };
  return {
    threads,
    selectedThread,
    messages: [...storedMessages].sort(compareMessages).map(messageDto),
    pendingSubmission,
    requestedSubmissionId,
    unavailable: false,
  };
}

function requestedExternalCapability(question: string): string | null {
  // A question about an already attempted action is a read of durable outcome,
  // not a fresh instruction to use an external connector.
  if (isAskActionOutcomeQuestion(question)) return null;
  const text = question.toLowerCase();
  const asksForExternalUse = /\b(send|reply|email|post|message|notify|update|change|write|add|create|read|show|find|search|fetch|check)\b/.test(text);
  if (!asksForExternalUse) return null;
  if (/\b(gmail|email|inbox)\b/.test(text)) return /\b(send|reply)\b/.test(text) || /^email\b/.test(text) ? "gmail_send_email" : "gmail_new_email";
  if (/\b(slack|channel)\b/.test(text)) return /\b(send|post|message|notify|reply)\b/.test(text) ? "slack_send_channel_message" : "slack_new_channel_message";
  if (/\b(sheet|sheets|spreadsheet|worksheet)\b/.test(text)) return /\b(update|change|write|mark|set)\b/.test(text)
    ? "google_sheets_update_row" : /\b(add|append|create)\b/.test(text)
      ? "google_sheets_add_row" : "google_sheets_find_row";
  if (/\bnotion\b/.test(text)) return /\b(update|change|write)\b/.test(text) ? "notion_update_item" : "notion_find_item";
  if (/\bcalendar|event\b/.test(text)) return "google_calendar";
  const registryMatch = Object.values(CAPABILITY_REGISTRY)
    .filter((capability) => capability.category === "destination" && capability.intentRecognizable)
    .flatMap((capability) => capability.aliases.map((alias) => ({ capability, alias: alias.toLowerCase() })))
    .filter(({ alias }) => text.includes(alias))
    .sort((left, right) => right.alias.length - left.alias.length)[0];
  return registryMatch?.capability.id ?? null;
}

function rpcError(error: { message: string } | null): never {
  if (error?.message.includes("Ask request identity conflict")
    || error?.message.includes("Only the latest Ask turn can be retried")) {
    throw new AskReliabilityError("CONFLICT");
  }
  if (error?.message.includes("Ask request is unavailable")
    || error?.message.includes("Conversation")
    || error?.message.includes("query returned no rows")) {
    throw new AskReliabilityError("DENIED");
  }
  throw new AskReliabilityError("UNAVAILABLE");
}

function parseClaim(row: AskRpcRow | undefined): AskTurnClaim {
  if (!row || !CLAIM_DISPOSITIONS.has(row.disposition) || !row.resolved_thread_id || !row.logical_request_id) {
    throw new AskReliabilityError("UNAVAILABLE");
  }
  const metadata = safeMetadata(row.assistant_metadata);
  const response = row.assistant_content && metadata ? { answer: row.assistant_content, metadata } : null;
  if (row.disposition === "completed" && !response) throw new AskReliabilityError("UNAVAILABLE");
  return {
    disposition: row.disposition as AskTurnClaim["disposition"],
    turnId: row.turn_id,
    threadId: row.resolved_thread_id,
    requestId: row.logical_request_id,
    question: row.submitted_question,
    turnSequence: row.turn_sequence,
    userSequenceNo: row.user_sequence_no,
    attemptToken: row.attempt_token,
    attemptGeneration: row.attempt_generation,
    failureCategory: FAILURE_CATEGORIES.has(row.failure_category as AskFailureCategory)
      ? row.failure_category as AskFailureCategory
      : null,
    response,
  };
}

function createAskTurnStore(auth: AuthContext): AskTurnStore {
  const admin = createAdminClient();
  async function resultOf(name: "claim_ask_turn" | "get_ask_turn_status" | "retry_ask_turn", args: Record<string, unknown>) {
    const { data, error } = await admin.rpc(name, args as never);
    if (error) rpcError(error);
    return parseClaim((data as AskRpcRow[] | null)?.[0]);
  }
  return {
    claim(input) {
      return resultOf("claim_ask_turn", {
        p_actor_user_id: auth.user.id,
        p_request_id: input.requestId,
        p_thread_id: input.threadId ?? null,
        p_question: input.question,
        p_thread_title: input.title,
        p_lease_seconds: input.leaseSeconds,
      });
    },
    retry(input) {
      return resultOf("retry_ask_turn", {
        p_actor_user_id: auth.user.id,
        p_request_id: input.requestId,
        p_thread_id: input.threadId ?? null,
        p_lease_seconds: input.leaseSeconds,
      });
    },
    status(input) {
      return resultOf("get_ask_turn_status", {
        p_actor_user_id: auth.user.id,
        p_request_id: input.requestId,
        p_thread_id: input.threadId ?? null,
      });
    },
    async loadHistory(input) {
      const { data, error } = await admin.from("ask_messages")
        .select("id,thread_id,workspace_id,user_id,role,content,response_metadata,created_at,turn_id,turn_position,sequence_no")
        .eq("thread_id", input.threadId)
        .eq("workspace_id", auth.workspace.id)
        .eq("user_id", auth.user.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(ASK_LIMITS.messages);
      if (error) throw new Error("ASK_HISTORY_UNAVAILABLE");
      return [...data]
        .filter((message) => message.turn_id !== input.turnId
          && (message.sequence_no === null || message.sequence_no < input.userSequenceNo))
        .sort(compareMessages)
        .slice(-ASK_LIMITS.historyMessages)
        .map(({ role, content }) => ({ role, content }));
    },
    async complete(input) {
      const { data, error } = await admin.rpc("complete_ask_turn", {
        p_actor_user_id: auth.user.id,
        p_request_id: input.requestId,
        p_attempt_token: input.attemptToken,
        p_attempt_generation: input.attemptGeneration,
        p_answer: input.response.answer,
        p_response_metadata: input.response.metadata as Json,
      });
      if (error) rpcError(error);
      return data;
    },
    async fail(input) {
      const { data, error } = await admin.rpc("fail_ask_turn", {
        p_actor_user_id: auth.user.id,
        p_request_id: input.requestId,
        p_attempt_token: input.attemptToken,
        p_attempt_generation: input.attemptGeneration,
        p_failure_category: input.category,
      });
      if (error) rpcError(error);
      return data;
    },
  };
}

async function generateResponse(auth: AuthContext, question: string, history: AskHistoryMessage[]): Promise<AskGroundedResponse> {
  const action = await planAskAction({
    userId: auth.user.id,
    workspaceId: auth.workspace.id,
    supabase: auth.supabase,
  }, question);
  if (action) return action;
  const isKnowledgeRead = selectAskTools(question).includes("company_knowledge")
    && !/\b(?:send|reply|post|notify|add|append|update|write|create)\b/i.test(question);
  const externalCapabilityId = isKnowledgeRead ? null : requestedExternalCapability(question);
  if (externalCapabilityId) {
    const capability = getCapability(externalCapabilityId);
    if (!capability?.supported || !capability.availableInProduction) {
      return unsupportedAskResponse(capability?.displayName ?? "that external capability");
    }
    // Only the deterministic action planner can construct an executable Ask
    // preview. A supported workflow action is not automatically an Ask action.
    if (externalCapabilityId === "gmail_send_email"
      || externalCapabilityId === "google_sheets_add_row"
      || externalCapabilityId === "google_sheets_update_row") {
      return unsupportedAskResponse("this request without an exact approved action preview");
    }
  }
  return runGroundedAsk({
    question,
    history,
    loadTool: (tool) => executeAskTool(tool, { userId: auth.user.id, workspaceId: auth.workspace.id }, question),
    callModel: async (context) => withConcurrencyLease(
      "user-ask",
      [auth.user.id],
      2,
      async () => {
        await enforceRateLimit("ai-execution", [auth.user.id], SECURITY_LIMITS.ai);
        await enforceUsageQuota(auth.user.id, "ai_generations");
        await enforceUsageQuota(auth.user.id, "ai_input_chars", context.length);
        const result = await callAskModel(context);
        await enforceUsageQuota(
          auth.user.id,
          "ai_output_tokens",
          result.outputTokens ?? Math.max(1, Math.ceil(result.text.length / 4)),
        );
        return result.text;
      },
      60,
    ),
  });
}

function classifyFailure(error: unknown): AskFailureCategory {
  if (error instanceof SecurityGateError) {
    if (error.code === "RATE_LIMITED") return "rate_limited";
    if (error.code === "QUOTA_EXCEEDED") return "quota_exceeded";
    if (error.code === "BUSY") return "capacity_busy";
    return "unavailable";
  }
  return "generation_failed";
}

function rejected(input: {
  requestId?: string | null;
  threadId?: string | null;
  error: string;
  outcome?: "rejected" | "uncertain";
}): AskSubmissionResult {
  return {
    ok: false,
    requestId: input.requestId ?? null,
    threadId: input.threadId ?? null,
    outcome: input.outcome ?? "rejected",
    messageSaved: input.outcome === "uncertain" ? null : false,
    replayed: false,
    retryable: false,
    error: input.error,
  };
}

async function runAuthorized(
  auth: AuthContext,
  input: { requestId: string; threadId?: string; message: string },
  mode: "submit" | "retry",
): Promise<AskSubmissionResult> {
  const store = createAskTurnStore(auth);
  return runReliableAskSubmission({
    mode,
    requestId: input.requestId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    question: input.message,
    title: deterministicThreadTitle(input.message || "Retry question"),
  }, {
    store,
    generate: ({ question, history }) => generateResponse(auth, question, history),
    classifyFailure,
  });
}

function safeReliabilityError(error: unknown, requestId: string, threadId?: string): AskSubmissionResult {
  if (error instanceof AskReliabilityError && error.code === "CONFLICT") {
    return rejected({ requestId, threadId, error: "This request identifier belongs to a different question or conversation." });
  }
  if (error instanceof AskReliabilityError && error.code === "DENIED") {
    return rejected({ requestId, threadId, error: "This Ask request is unavailable." });
  }
  if (error instanceof SecurityGateError && error.code === "RATE_LIMITED") {
    return rejected({ requestId, threadId, error: "Too many Ask requests. Try again shortly." });
  }
  return rejected({
    requestId,
    threadId,
    error: "Ask CrazyLoops is unavailable right now. Your message was not confirmed as saved.",
    outcome: "uncertain",
  });
}

export async function sendAskMessage(input: unknown): Promise<SendAskResult> {
  const parsed = AskInputSchema.safeParse(input);
  if (!parsed.success) return rejected({ error: "Enter a valid message of 2,000 characters or fewer." });
  if (LIKELY_SECRET.test(parsed.data.message)) {
    return rejected({
      requestId: parsed.data.requestId,
      threadId: parsed.data.threadId,
      error: "Remove credentials or access tokens before asking CrazyLoops.",
    });
  }
  const auth = await getAuthenticatedContext();
  if (!auth) return rejected({ requestId: parsed.data.requestId, error: "Sign in to use Ask CrazyLoops." });
  try {
    await enforceRateLimit("ask-user", [auth.user.id], SECURITY_LIMITS.ask);
    return await runAuthorized(auth, parsed.data, "submit");
  } catch (error) {
    securityLog("Ask submission failed", { error, userId: auth.user.id, requestId: parsed.data.requestId });
    return safeReliabilityError(error, parsed.data.requestId, parsed.data.threadId);
  }
}

export async function retryAskMessage(input: unknown): Promise<SendAskResult> {
  const parsed = AskRequestReferenceSchema.safeParse(input);
  if (!parsed.success) return rejected({ error: "This Ask request cannot be retried safely." });
  const auth = await getAuthenticatedContext();
  if (!auth) return rejected({ requestId: parsed.data.requestId, error: "Sign in to use Ask CrazyLoops." });
  try {
    await enforceRateLimit("ask-user", [auth.user.id], SECURITY_LIMITS.ask);
    return await runAuthorized(auth, { ...parsed.data, message: "" }, "retry");
  } catch (error) {
    securityLog("Ask retry failed", { error, userId: auth.user.id, requestId: parsed.data.requestId });
    return safeReliabilityError(error, parsed.data.requestId, parsed.data.threadId);
  }
}

export async function getAskMessageStatus(input: unknown): Promise<SendAskResult> {
  const parsed = AskRequestReferenceSchema.safeParse(input);
  if (!parsed.success) return rejected({ error: "This Ask request cannot be checked safely." });
  const auth = await getAuthenticatedContext();
  if (!auth) return rejected({ requestId: parsed.data.requestId, error: "Sign in to use Ask CrazyLoops." });
  try {
    await enforceRateLimit("ask-status", [auth.user.id], SECURITY_LIMITS.askStatus);
    return await readReliableAskStatus(parsed.data, createAskTurnStore(auth));
  } catch (error) {
    securityLog("Ask status check failed", { error, userId: auth.user.id, requestId: parsed.data.requestId });
    return safeReliabilityError(error, parsed.data.requestId, parsed.data.threadId);
  }
}
