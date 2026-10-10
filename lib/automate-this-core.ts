import { createHash } from "node:crypto";

export const AUTOMATION_EVIDENCE_DAYS = 14;
export const AUTOMATION_MIN_INSTANCES = 3;

export type RepeatedWorkKind = "gmail_follow_up" | "work_item_ai_result";

export type RepeatedWorkEvidence = {
  workItemId: string;
  kind: RepeatedWorkKind;
  sourceType: string;
  title: string;
  completedAt: string;
};

export type RepeatedWorkPattern = {
  key: string;
  kind: RepeatedWorkKind;
  sourceType: string;
  title: string;
  count: number;
  workItemIds: string[];
  firstAt: string;
  lastAt: string;
  explanation: string;
};

/** Exact normalized task titles are deliberately conservative: connector identity alone is never a pattern. */
export function normalizedWorkTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** A Gmail handoff alone is not a follow-up. Require a materially relevant Work Item title. */
export function isFollowUpWorkTitle(title: string): boolean {
  return /\b(?:follow[ -]?up|following up|not replied|no reply|awaiting reply|waiting for reply|unresponsive)\b/i.test(title);
}

export function matchingAutomationWorkItem(input: {
  title: string; sourceType: string; status: string; createdAt: string; dueAt: string | null;
  publishedAt: string; now: Date; waitDays: number | null;
}, expected: { title: string; sourceType: string }): boolean {
  const created = Date.parse(input.createdAt);
  const published = Date.parse(input.publishedAt);
  const due = input.dueAt ? Date.parse(input.dueAt) : NaN;
  if (input.title !== expected.title || input.sourceType !== expected.sourceType
    || !Number.isFinite(created) || !Number.isFinite(published) || created < published) return false;
  if (input.waitDays === null) return ["needs_you", "waiting"].includes(input.status);
  return input.status === "waiting" && input.dueAt !== null
    && Number.isFinite(due) && due <= input.now.getTime()
    && created + input.waitDays * 86_400_000 <= input.now.getTime();
}

export function detectRepeatedWork(
  evidence: readonly RepeatedWorkEvidence[],
  now = new Date(),
): RepeatedWorkPattern[] {
  const cutoff = now.getTime() - AUTOMATION_EVIDENCE_DAYS * 86_400_000;
  const groups = new Map<string, RepeatedWorkEvidence[]>();
  for (const item of evidence) {
    const timestamp = Date.parse(item.completedAt);
    const title = normalizedWorkTitle(item.title);
    if (!title || title.length < 5 || !Number.isFinite(timestamp)
      || timestamp < cutoff || timestamp > now.getTime()
      || !["connector_event", "system", "internal"].includes(item.sourceType)
      || !/^[0-9a-f-]{36}$/i.test(item.workItemId)) continue;
    const group = `${item.kind}\u0000${item.sourceType}\u0000${title}`;
    const entries = groups.get(group) ?? [];
    entries.push(item);
    groups.set(group, entries);
  }

  return [...groups.entries()].flatMap(([identity, items]) => {
    const distinct = [...new Map(items.map((item) => [item.workItemId, item])).values()]
      .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
    if (distinct.length < AUTOMATION_MIN_INSTANCES) return [];
    const first = distinct[0];
    const last = distinct[distinct.length - 1];
    const title = first.title.trim().slice(0, 180);
    const kind = first.kind;
    return [{
      key: createHash("sha256").update(identity).digest("hex"),
      kind,
      sourceType: first.sourceType,
      title,
      count: distinct.length,
      workItemIds: distinct.slice(-12).map((item) => item.workItemId),
      firstAt: first.completedAt,
      lastAt: last.completedAt,
      explanation: kind === "gmail_follow_up"
        ? `You approved and sent ${distinct.length} Gmail follow-ups for work titled “${title}” in the last ${AUTOMATION_EVIDENCE_DAYS} days.`
        : `You finalized ${distinct.length} AI-assisted results for work titled “${title}” in the last ${AUTOMATION_EVIDENCE_DAYS} days.`,
    }];
  }).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}
