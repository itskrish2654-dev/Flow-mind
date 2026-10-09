import { z } from "zod";

export const WorkModeSchema = z.enum(["GENERAL", "RESEARCH", "WRITING", "DATA", "CODING", "MARKETING"]);
export type WorkMode = z.infer<typeof WorkModeSchema>;

export const WorkbenchGenerateSchema = z.object({
  workItemId: z.uuid(), requestKey: z.uuid(),
  instruction: z.string().trim().min(3).max(2000),
}).strict();

export const WorkbenchSaveSchema = z.object({
  workItemId: z.uuid(), requestKey: z.uuid(),
  title: z.string().trim().min(1).max(180),
  content: z.string().trim().min(1).max(16000),
  aiTurnId: z.uuid().nullish(), basedOnId: z.uuid().nullish(),
}).strict();

export const LIKELY_WORKBENCH_SECRET = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:gsk|sk|sb_secret)_[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/i;

const WorkbenchModelResultSchema = z.object({
  title: z.string().trim().min(1).max(180),
  content: z.string().trim().min(1).max(16000),
  sourceKeys: z.array(z.string().regex(/^knowledge_chunk:[0-7]$/)).max(8),
}).strict();

export function classifyWorkMode(text: string): WorkMode {
  const value = text.toLowerCase();
  if (/\b(code|coding|script|typescript|javascript|python|bug|repository)\b/.test(value)) return "CODING";
  if (/\b(research|competitor|compare|investigate|evidence)\b/.test(value)) return "RESEARCH";
  if (/\b(spreadsheet|sheet|data|table|metric|analysis|analyse|analyze)\b/.test(value)) return "DATA";
  if (/\b(campaign|marketing|messaging|positioning|advert|copy)\b/.test(value)) return "MARKETING";
  if (/\b(write|draft|brief|report|update|email|summary)\b/.test(value)) return "WRITING";
  return "GENERAL";
}

export function parseWorkbenchModelResult(text: string, availableKeys: readonly string[]) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const parsed = WorkbenchModelResultSchema.parse(JSON.parse(fenced ? fenced[1] : trimmed));
  const allowed = new Set(availableKeys);
  if (parsed.sourceKeys.some((key) => !allowed.has(key)) || new Set(parsed.sourceKeys).size !== parsed.sourceKeys.length) {
    throw new Error("AI result cited an unavailable source.");
  }
  if (/\b(?:I|we|CrazyLoops)\s+(?:have\s+)?(?:sent\s+(?:the\s+)?(?:email|message)|posted\s+(?:to|in)\s+Slack|published\s+(?:the\s+)?(?:page|document)|updated\s+(?:the\s+)?(?:calendar|spreadsheet))\b/i.test(parsed.content)) {
    throw new Error("AI result claimed an unexecuted external action.");
  }
  return parsed;
}

/** A final result is reviewable; working turns and drafts are never manager-visible. */
export function canReadWorkbenchRecord(input: {
  kind: "turn" | "deliverable"; status: string; ownerUserId: string;
  viewerUserId: string; viewerRole: "member" | "admin" | "owner";
  sameWorkspace: boolean; goalId: string | null; stillAssigned: boolean;
}) {
  if (!input.sameWorkspace) return false;
  if (input.ownerUserId === input.viewerUserId && input.stillAssigned) return true;
  return input.kind === "deliverable" && input.status === "final" && input.goalId !== null
    && input.viewerRole !== "member";
}
