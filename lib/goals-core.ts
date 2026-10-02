import { z } from "zod";

export const GOAL_LIMITS = { plans: 100, items: 12, list: 50, sources: 8 } as const;

const optionalText = (max: number) => z.string().trim().max(max).nullish();
export const GoalDraftSchema = z.object({
  requestId: z.uuid(),
  title: z.string().trim().min(8).max(180),
  description: optionalText(2000),
  successCriteria: optionalText(1000),
  targetDate: z.iso.date().nullish(),
  ownerUserId: z.uuid(),
}).strict();

export const GoalDraftEditSchema = GoalDraftSchema.omit({ requestId: true }).extend({
  goalId: z.uuid(), expectedUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const GoalPlanItemSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: optionalText(1000),
  rationale: optionalText(500),
  suggestedOwnerRole: optionalText(80),
  assigneeUserId: z.uuid().nullish(),
  dueAt: z.iso.datetime({ offset: true }).nullish(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
}).strict();

export const GoalPlanEditSchema = z.object({
  goalId: z.uuid(), expectedRevision: z.number().int().min(0).max(99),
  items: z.array(GoalPlanItemSchema).min(1).max(GOAL_LIMITS.items),
}).strict();

export const GoalModelProposalSchema = z.object({
  goalSummary: z.string().trim().min(1).max(300),
  successCriteria: z.string().trim().min(1).max(1000),
  clarificationRequired: z.boolean(),
  questions: z.array(z.string().trim().min(1).max(250)).max(2),
  planItems: z.array(GoalPlanItemSchema.omit({ assigneeUserId: true, dueAt: true, priority: true }))
    .max(GOAL_LIMITS.items),
  sourceKeys: z.array(z.string().regex(/^knowledge_chunk:\d+$/)).max(GOAL_LIMITS.sources),
}).strict().superRefine((proposal, context) => {
  if (proposal.clarificationRequired && (proposal.questions.length === 0 || proposal.planItems.length > 0)) {
    context.addIssue({ code: "custom", message: "Clarification proposals cannot contain active plan items." });
  }
  if (!proposal.clarificationRequired && (proposal.questions.length > 0 || proposal.planItems.length === 0)) {
    context.addIssue({ code: "custom", message: "A complete proposal needs plan items, not questions." });
  }
});

export function parseGoalModelProposal(text: string, availableKeys: readonly string[]) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const proposal = GoalModelProposalSchema.parse(JSON.parse(fenced ? fenced[1] : trimmed));
  const known = new Set(availableKeys);
  if (proposal.sourceKeys.some((key) => !known.has(key)) || new Set(proposal.sourceKeys).size !== proposal.sourceKeys.length) {
    throw new Error("Plan cited an unavailable company source.");
  }
  return proposal;
}

export function goalNeedsClarification(input: { title: string; successCriteria?: string | null }): string | null {
  const criteria = input.successCriteria?.trim() ?? "";
  if (criteria.length < 10 || /^(?:grow|improve|increase|better|more|success|done)(?:\s+\w+){0,2}\.?$/i.test(criteria)) {
    return "What measurable outcome will show this goal is complete? Include a target or a specific deliverable.";
  }
  if (/^(?:grow|improve|increase|better)\s+\w+\.?$/i.test(input.title.trim()) && !/\d/.test(criteria)
    && !/\b(?:completed|delivered|published|accepted|launched|migrated|approved)\b/i.test(criteria)) {
    return "What specific result are you targeting, and by when?";
  }
  return null;
}

export type GoalWorkState = { status: "needs_you" | "waiting" | "handled" | "done"; dueAt: string | null } | null;
export function deriveGoalProgress(items: readonly GoalWorkState[], now = new Date()): {
  completed: number; total: number; needsAttention: number; overdue: number; missing: number;
} {
  let completed = 0; let needsAttention = 0; let overdue = 0; let missing = 0;
  for (const item of items) {
    if (!item) { missing += 1; needsAttention += 1; continue; }
    if (item.status === "done") { completed += 1; continue; }
    if (item.status === "needs_you") needsAttention += 1;
    if (item.dueAt && new Date(item.dueAt) < now) overdue += 1;
  }
  return { completed, total: items.length, needsAttention, overdue, missing };
}
