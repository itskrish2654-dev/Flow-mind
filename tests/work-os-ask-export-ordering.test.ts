import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  orderAskMessagesForExport,
  orderAskTurnsForExport,
  type AskExportOrder,
} from "../lib/ask-export-ordering";

type ExportRow = Record<string, string | number | null>;
type QueryOperation =
  | { type: "order"; order: AskExportOrder }
  | { type: "limit"; count: number };

class ExportQueryMock<Row extends ExportRow> {
  readonly operations: QueryOperation[] = [];
  readonly filters: Array<{ column: string; value: string }> = [];
  private readonly ordering: AskExportOrder[] = [];
  private resultLimit: number | null = null;

  constructor(private readonly rows: readonly Row[]) {}

  eq(column: string, value: string) {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }) {
    assert.equal(options.ascending, true);
    const order = {
      column: column as AskExportOrder["column"],
      ascending: true,
      ...(options.nullsFirst === true ? { nullsFirst: true } : {}),
    } as AskExportOrder;
    this.ordering.push(order);
    this.operations.push({ type: "order", order });
    return this;
  }

  limit(count: number) {
    this.resultLimit = count;
    this.operations.push({ type: "limit", count });
    return this;
  }

  execute(): Row[] {
    const ordered = [...this.rows].sort((left, right) => {
      for (const { column, nullsFirst } of this.ordering) {
        const leftValue = left[column];
        const rightValue = right[column];
        if (leftValue === rightValue) continue;
        if (leftValue === null) return nullsFirst ? -1 : 1;
        if (rightValue === null) return nullsFirst ? 1 : -1;
        if (leftValue < rightValue) return -1;
        if (leftValue > rightValue) return 1;
      }
      return 0;
    });
    return this.resultLimit === null ? ordered : ordered.slice(0, this.resultLimit);
  }
}

const sameTime = "2026-09-28T12:00:00.000Z";

function message(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: "message-1",
    thread_id: "thread-a",
    turn_id: "turn-1",
    turn_position: 0,
    sequence_no: 1,
    role: "user",
    content: "Question",
    response_metadata: null,
    created_at: sameTime,
    ...overrides,
  };
}

function turn(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: "turn-1",
    thread_id: "thread-a",
    request_id: "request-1",
    question: "Question",
    state: "processing",
    turn_sequence: 1,
    failure_category: null,
    created_at: sameTime,
    updated_at: sameTime,
    completed_at: null,
    failed_at: null,
    ...overrides,
  };
}

function orderedMessages(rows: readonly ExportRow[], limit = rows.length): ExportQueryMock<ExportRow> {
  return orderAskMessagesForExport(new ExportQueryMock(rows)).limit(limit);
}

function orderedTurns(rows: readonly ExportRow[], limit = rows.length): ExportQueryMock<ExportRow> {
  return orderAskTurnsForExport(new ExportQueryMock(rows)).limit(limit);
}

test("messages with timestamp ties and shuffled IDs export in sequence order", () => {
  const query = orderedMessages([
    message({ id: "message-a", sequence_no: 3 }),
    message({ id: "message-z", sequence_no: 1 }),
    message({ id: "message-m", sequence_no: 2 }),
  ]);
  assert.deepEqual(query.execute().map((row) => row.sequence_no), [1, 2, 3]);
});

test("turns with timestamp ties export in turn sequence order", () => {
  const query = orderedTurns([
    turn({ id: "turn-a", turn_sequence: 3 }),
    turn({ id: "turn-z", turn_sequence: 1 }),
    turn({ id: "turn-m", turn_sequence: 2 }),
  ]);
  assert.deepEqual(query.execute().map((row) => row.turn_sequence), [1, 2, 3]);
});

test("timestamps do not override sequence order within a conversation", () => {
  const query = orderedMessages([
    message({ id: "later-sequence", sequence_no: 2, created_at: "2026-01-01T00:00:00.000Z" }),
    message({ id: "earlier-sequence", sequence_no: 1, created_at: "2026-12-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(query.execute().map((row) => row.id), ["earlier-sequence", "later-sequence"]);
});

test("conversation-local sequences remain deterministically grouped by conversation", () => {
  const rows = [
    message({ id: "b-2", thread_id: "thread-b", sequence_no: 2 }),
    message({ id: "a-2", thread_id: "thread-a", sequence_no: 2 }),
    message({ id: "b-1", thread_id: "thread-b", sequence_no: 1 }),
    message({ id: "a-1", thread_id: "thread-a", sequence_no: 1 }),
  ];
  assert.deepEqual(orderedMessages(rows).execute().map((row) => row.id), ["a-1", "a-2", "b-1", "b-2"]);
  assert.deepEqual(orderedMessages([...rows].reverse()).execute().map((row) => row.id), ["a-1", "a-2", "b-1", "b-2"]);
});

test("legacy null sequences use deterministic timestamp and ID fallback before sequenced rows", () => {
  const query = orderedMessages([
    message({ id: "legacy-z", sequence_no: null, turn_id: null, turn_position: null }),
    message({ id: "sequenced", sequence_no: 1 }),
    message({ id: "legacy-a", sequence_no: null, turn_id: null, turn_position: null }),
    message({ id: "legacy-older", sequence_no: null, turn_id: null, turn_position: null, created_at: "2026-01-01T00:00:00.000Z" }),
  ]);
  assert.deepEqual(query.execute().map((row) => row.id), ["legacy-older", "legacy-a", "legacy-z", "sequenced"]);
});

test("a failed question remains present without fabricating an assistant answer", () => {
  const failedQuestion = message({ id: "failed-question", sequence_no: 1, content: "Failed question" });
  const result = orderedMessages([failedQuestion]).execute();
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "failed-question");
  assert.equal(result[0]?.role, "user");
});

test("unchanged fixtures produce identical export order repeatedly", () => {
  const rows = [
    message({ id: "b", sequence_no: 2 }),
    message({ id: "a", sequence_no: 1 }),
  ];
  assert.deepEqual(orderedMessages(rows).execute(), orderedMessages(rows).execute());
});

test("ordering is applied before limit at a tied boundary", () => {
  const query = orderedMessages([
    message({ id: "sequence-3", sequence_no: 3 }),
    message({ id: "sequence-1", sequence_no: 1 }),
    message({ id: "sequence-2", sequence_no: 2 }),
  ], 2);
  assert.deepEqual(query.operations.map((operation) => operation.type), ["order", "order", "order", "order", "limit"]);
  assert.deepEqual(query.execute().map((row) => row.id), ["sequence-1", "sequence-2"]);
});

test("the account export route uses the behavioral ordering helpers before limits", () => {
  const route = readFileSync(new URL("../app/settings/export/route.ts", import.meta.url), "utf8");
  assert.match(route, /orderAskTurnsForExport\(admin\.from\("ask_turns"\)[\s\S]*?\.eq\("workspace_id", auth\.workspace\.id\)[\s\S]*?\.eq\("user_id", auth\.user\.id\)\)\s*\.limit\(EXPORT_LIMITS\.askTurns \+ 1\)/);
  assert.match(route, /orderAskMessagesForExport\(admin\.from\("ask_messages"\)[\s\S]*?\.eq\("workspace_id", auth\.workspace\.id\)[\s\S]*?\.eq\("user_id", auth\.user\.id\)\)\s*\.limit\(EXPORT_LIMITS\.askMessages \+ 1\)/);
});

test("the export keeps safe projections and excludes lifecycle-control fields", () => {
  const route = readFileSync(new URL("../app/settings/export/route.ts", import.meta.url), "utf8");
  const askSection = route.slice(route.indexOf('admin.from("ask_turns")'), route.indexOf("const results"));
  assert.match(askSection, /turn_sequence/);
  assert.match(askSection, /sequence_no/);
  assert.doesNotMatch(askSection, /attempt_token|attempt_generation|lease_until/);
  assert.doesNotMatch(askSection, /select\("\*"\)/);
});
