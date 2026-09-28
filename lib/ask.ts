import "server-only";

import { z } from "zod";

import {
  ASK_LIMITS,
  AskInputSchema,
  AskResponseMetadataSchema,
  deterministicThreadTitle,
  runGroundedAsk,
  unsupportedAskResponse,
  type AskGroundedResponse,
  type AskHistoryMessage,
  type AskResponseMetadata,
} from "@/lib/ask-core";
import { callAskModel } from "@/lib/ask-model";
import { executeAskTool } from "@/lib/ask-tools";
import { getAuthenticatedContext } from "@/lib/auth";
import { CAPABILITY_REGISTRY, getCapability } from "@/lib/capability-registry";
import { SECURITY_LIMITS, enforceRateLimit, enforceUsageQuota, withConcurrencyLease } from "@/lib/security/limits";
import { securityLog } from "@/lib/security/redaction";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

type AskThreadRow = Database["public"]["Tables"]["ask_threads"]["Row"];
type AskMessageRow = Database["public"]["Tables"]["ask_messages"]["Row"];

export type AskThreadDto = Pick<AskThreadRow, "id" | "title" | "created_at" | "updated_at">;
export type AskMessageDto = Pick<AskMessageRow, "id" | "role" | "content" | "created_at"> & {
  metadata: AskResponseMetadata | null;
};
export type AskPageData = {
  threads: AskThreadDto[];
  selectedThread: AskThreadDto | null;
  messages: AskMessageDto[];
  unavailable: boolean;
};
export type SendAskResult =
  | { ok: true; threadId: string; response: AskGroundedResponse }
  | { ok: false; threadId: string | null; error: string };

const LIKELY_SECRET = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:gsk|sk|sb_secret)_[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/i;

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

export async function loadAskPageData(threadId?: string): Promise<AskPageData | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;
  const { data: threads, error: threadError } = await auth.supabase.from("ask_threads")
    .select("id,title,created_at,updated_at")
    .eq("workspace_id", auth.workspace.id)
    .eq("user_id", auth.user.id)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(ASK_LIMITS.threads);
  if (threadError) return { threads: [], selectedThread: null, messages: [], unavailable: true };

  const parsedThreadId = threadId ? z.uuid().safeParse(threadId) : null;
  if (threadId && !parsedThreadId?.success) {
    return { threads, selectedThread: null, messages: [], unavailable: true };
  }
  const selectedThread = parsedThreadId?.success
    ? threads.find((thread) => thread.id === parsedThreadId.data) ?? null
    : null;
  if (threadId && !selectedThread) {
    return { threads, selectedThread: null, messages: [], unavailable: true };
  }
  if (!selectedThread) return { threads, selectedThread: null, messages: [], unavailable: false };

  const { data: descendingMessages, error: messageError } = await auth.supabase.from("ask_messages")
    .select("id,thread_id,workspace_id,user_id,role,content,response_metadata,created_at")
    .eq("thread_id", selectedThread.id)
    .eq("workspace_id", auth.workspace.id)
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ASK_LIMITS.messages);
  if (messageError) return { threads, selectedThread, messages: [], unavailable: true };
  return {
    threads,
    selectedThread,
    messages: descendingMessages.reverse().map(messageDto),
    unavailable: false,
  };
}

function requestedExternalCapability(question: string): string | null {
  const text = question.toLowerCase();
  const asksForExternalUse = /\b(send|reply|email|post|message|notify|update|change|write|add|create|read|show|find|search|fetch|check)\b/.test(text);
  if (!asksForExternalUse) return null;
  if (/\b(gmail|email|inbox)\b/.test(text)) return /\b(send|reply)\b/.test(text) || /^email\b/.test(text) ? "gmail_send_email" : "gmail_new_email";
  if (/\b(slack|channel)\b/.test(text)) return /\b(send|post|message|notify|reply)\b/.test(text) ? "slack_send_channel_message" : "slack_new_channel_message";
  if (/\b(sheet|sheets|spreadsheet)\b/.test(text)) return /\b(update|change|write)\b/.test(text) ? "google_sheets_update_row" : "google_sheets_find_row";
  if (/\bnotion\b/.test(text)) return /\b(update|change|write)\b/.test(text) ? "notion_update_item" : "notion_find_item";
  if (/\bcalendar|event\b/.test(text)) return "google_calendar";
  const registryMatch = Object.values(CAPABILITY_REGISTRY)
    .filter((capability) => capability.category === "destination" && capability.intentRecognizable)
    .flatMap((capability) => capability.aliases.map((alias) => ({ capability, alias: alias.toLowerCase() })))
    .filter(({ alias }) => text.includes(alias))
    .sort((left, right) => right.alias.length - left.alias.length)[0];
  return registryMatch?.capability.id ?? null;
}

async function loadHistory(threadId: string, workspaceId: string, userId: string): Promise<AskHistoryMessage[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("ask_messages")
    .select("role,content")
    .eq("thread_id", threadId)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ASK_LIMITS.historyMessages);
  if (error) throw new Error("Conversation history is unavailable.");
  return data.reverse();
}

async function resolveOwnedThread(input: {
  threadId?: string;
  question: string;
  workspaceId: string;
  userId: string;
}): Promise<AskThreadRow> {
  const admin = createAdminClient();
  if (input.threadId) {
    const { data, error } = await admin.from("ask_threads").select("*")
      .eq("id", input.threadId)
      .eq("workspace_id", input.workspaceId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (error || !data) throw new Error("Conversation is unavailable.");
    return data;
  }
  const { data, error } = await admin.from("ask_threads").insert({
    workspace_id: input.workspaceId,
    user_id: input.userId,
    title: deterministicThreadTitle(input.question),
  }).select("*").single();
  if (error || !data || data.workspace_id !== input.workspaceId || data.user_id !== input.userId) {
    throw new Error("Conversation could not be created.");
  }
  return data;
}

async function persistMessage(input: {
  threadId: string;
  workspaceId: string;
  userId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: AskResponseMetadata;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: thread, error: ownershipError } = await admin.from("ask_threads").select("id")
    .eq("id", input.threadId).eq("workspace_id", input.workspaceId).eq("user_id", input.userId).maybeSingle();
  if (ownershipError || !thread) throw new Error("Conversation is unavailable.");
  const { error } = await admin.from("ask_messages").insert({
    thread_id: input.threadId,
    workspace_id: input.workspaceId,
    user_id: input.userId,
    role: input.role,
    content: input.content,
    response_metadata: input.metadata ? input.metadata as Json : null,
  });
  if (error) throw new Error("Conversation message could not be saved.");
  const { error: updateError } = await admin.from("ask_threads").update({ updated_at: new Date().toISOString() })
    .eq("id", input.threadId).eq("workspace_id", input.workspaceId).eq("user_id", input.userId);
  if (updateError) throw new Error("Conversation could not be updated.");
}

function publicAskError(error: unknown): string {
  if (error instanceof Error && /Too many|limit|busy/i.test(error.message)) return error.message;
  return "Ask CrazyLoops could not complete that request safely. Your message is still in the conversation, so you can try again.";
}

export async function sendAskMessage(input: unknown): Promise<SendAskResult> {
  const parsed = AskInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, threadId: null, error: "Enter a message of 2,000 characters or fewer." };
  if (LIKELY_SECRET.test(parsed.data.message)) {
    return { ok: false, threadId: parsed.data.threadId ?? null, error: "Remove credentials or access tokens before asking CrazyLoops." };
  }
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, threadId: null, error: "Sign in to use Ask CrazyLoops." };

  let threadId: string | null = parsed.data.threadId ?? null;
  try {
    await enforceRateLimit("ask-user", [auth.user.id], SECURITY_LIMITS.ask);
    const thread = await resolveOwnedThread({
      threadId: parsed.data.threadId,
      question: parsed.data.message,
      workspaceId: auth.workspace.id,
      userId: auth.user.id,
    });
    threadId = thread.id;
    const history = await loadHistory(thread.id, auth.workspace.id, auth.user.id);
    // Persist the employee's message before tools or the provider can fail.
    await persistMessage({
      threadId: thread.id,
      workspaceId: auth.workspace.id,
      userId: auth.user.id,
      role: "user",
      content: parsed.data.message,
    });

    const externalCapabilityId = requestedExternalCapability(parsed.data.message);
    let response: AskGroundedResponse;
    if (externalCapabilityId) {
      const capability = getCapability(externalCapabilityId);
      response = unsupportedAskResponse(capability?.displayName ?? "that external capability");
    } else {
      response = await runGroundedAsk({
        question: parsed.data.message,
        history,
        loadTool: (tool) => executeAskTool(tool, { userId: auth.user.id, workspaceId: auth.workspace.id }),
        callModel: async (context) => {
          return withConcurrencyLease(
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
          );
        },
      });
    }
    await persistMessage({
      threadId: thread.id,
      workspaceId: auth.workspace.id,
      userId: auth.user.id,
      role: "assistant",
      content: response.answer,
      metadata: response.metadata,
    });
    return { ok: true, threadId: thread.id, response };
  } catch (error) {
    securityLog("Ask request failed", { error, userId: auth.user.id, threadId });
    return { ok: false, threadId, error: publicAskError(error) };
  }
}
