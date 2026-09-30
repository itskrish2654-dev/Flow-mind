import {
  ASK_LIMITS,
  boundedText,
  buildMyDayAskFacts,
  type AskReferenceKind,
  type AskToolRecord,
  type AskToolResult,
} from "@/lib/ask-core";
import {
  durableMyDayItem,
  type MyDayData,
  type MyDayItem,
} from "@/lib/my-day-model";
import type { WorkItem } from "@/lib/work-items-core";

type RankedMyDayItem = {
  item: MyDayItem;
  section: number;
  sourceOrder: number;
};

function timestampValue(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function rankedPresentationItems(data: MyDayData): RankedMyDayItem[] {
  let sourceOrder = 0;
  return [
    ...data.needsYou.map((item) => ({ item, section: 0, sourceOrder: sourceOrder++ })),
    ...data.waitingOn.map((item) => ({ item, section: 1, sourceOrder: sourceOrder++ })),
    ...data.handledByCrazyLoops.map((item) => ({ item, section: 2, sourceOrder: sourceOrder++ })),
    ...data.recentActivity.map((item) => ({ item, section: 3, sourceOrder: sourceOrder++ })),
  ];
}

function workItemSection(item: WorkItem): number {
  if (item.status === "needs_you") return 0;
  if (item.status === "waiting") return 1;
  return 2;
}

/**
 * My Day hides approval-linked Work Item cards to avoid duplicate UI actions.
 * Ask still needs those authoritative facts, so it merges missing owned items
 * before applying its final record bound.
 */
export function buildAskMyDayItems(input: {
  data: MyDayData;
  currentWorkItems: readonly WorkItem[];
  userId: string;
  workspaceId: string;
}): MyDayItem[] {
  const presentation = rankedPresentationItems(input.data);
  const existingWorkItemIds = new Set(
    presentation.flatMap(({ item }) => item.workItem?.id ? [item.workItem.id] : []),
  );
  let sourceOrder = presentation.length;
  const missingDurable = input.currentWorkItems
    .filter((item) => item.assignee_user_id === input.userId
      && item.workspace_id === input.workspaceId
      && item.status !== "done"
      && !existingWorkItemIds.has(item.id))
    .map<RankedMyDayItem>((item) => ({
      item: durableMyDayItem(item),
      section: workItemSection(item),
      sourceOrder: sourceOrder++,
    }));

  const seen = new Set<string>();
  return [...presentation, ...missingDurable]
    .sort((left, right) => left.section - right.section
      || left.item.priority - right.item.priority
      || timestampValue(right.item.timestamp) - timestampValue(left.item.timestamp)
      || left.item.id.localeCompare(right.item.id)
      || left.sourceOrder - right.sourceOrder)
    .flatMap(({ item }) => {
      const key = item.workItem?.id ? `work_item:${item.workItem.id}` : item.id;
      if (seen.has(key)) return [];
      seen.add(key);
      return [item];
    })
    .slice(0, ASK_LIMITS.recordsPerTool);
}

function uuidFromCompositeId(value: string): string | null {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null;
}

function safeRecord(input: {
  key: string;
  kind: AskReferenceKind;
  id: string;
  label: string;
  href: string;
  facts: Record<string, string | null | undefined>;
}): AskToolRecord {
  return {
    referenceKey: input.key,
    reference: {
      kind: input.kind,
      entityId: input.id,
      label: boundedText(input.label, "CrazyLoops item", 180),
      href: input.href,
    },
    facts: Object.fromEntries(Object.entries(input.facts).flatMap(([key, value]) => {
      if (!value) return [];
      return [[boundedText(key, "field", 80), boundedText(value, "", ASK_LIMITS.recordFieldCharacters)]];
    })),
  };
}

export function buildAskMyDayToolResult(input: {
  data: MyDayData;
  currentWorkItems: readonly WorkItem[];
  userId: string;
  workspaceId: string;
}): AskToolResult {
  const items = buildAskMyDayItems(input);
  const records = items.flatMap((item, index) => {
    const id = item.workItem?.id ?? uuidFromCompositeId(item.id);
    if (!id) return [];
    const kind: AskReferenceKind = item.id.startsWith("execution:") ? "execution"
      : item.id.startsWith("workflow:") ? "workflow" : "work_item";
    return [safeRecord({
      key: `${kind}:${index}`,
      kind,
      id,
      label: item.title,
      href: item.cta.href,
      facts: buildMyDayAskFacts(item),
    })];
  });
  return {
    tool: "my_day",
    summary: `${records.length} current My Day record${records.length === 1 ? " is" : "s are"} available to this employee.`,
    records,
  };
}
