import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AskReferenceSchema, runGroundedAsk, selectAskTools, type AskToolResult } from "../lib/ask-core";
import { activityLabel, activityOutcome, activitySourceHref, type ActivityEvent } from "../lib/activity-core";
import { deriveGoalProgress, goalNeedsClarification, GoalPlanEditSchema, parseGoalModelProposal } from "../lib/goals-core";
import { safeAuthReturnPath } from "../lib/auth-return-path";
import { createAiTextExecutor } from "../lib/ai-execution-core";

const migration = readFileSync("supabase/migrations/20261002200000_work_os_goals_v1.sql", "utf8");
const goalService = readFileSync("lib/goals.ts", "utf8");
const planningService = readFileSync("lib/goals-planning.ts", "utf8");
const goalId = "00000000-0000-4000-8000-000000000001";
const assigneeId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-10-02T12:00:00Z");

test("vague outcomes require clarification; measurable outcomes may proceed", () => {
  assert.match(goalNeedsClarification({ title: "Grow revenue" }) ?? "", /measurable/);
  assert.match(goalNeedsClarification({ title: "Grow revenue", successCriteria: "Improve sales" }) ?? "", /measurable/);
  assert.equal(goalNeedsClarification({ title: "Hire 3 support agents", successCriteria: "Three candidates accepted written offers." }), null);
});

test("model proposal is strict, bounded, source-scoped, and never assigns employees", () => {
  const valid = { goalSummary: "Hire support agents", successCriteria: "Three written offers accepted",
    clarificationRequired: false, questions: [],
    planItems: [{ title: "Prepare role description", description: null, rationale: null, suggestedOwnerRole: "Recruitment manager" }],
    sourceKeys: ["knowledge_chunk:0"] };
  assert.deepEqual(parseGoalModelProposal(JSON.stringify(valid), ["knowledge_chunk:0"]), valid);
  assert.deepEqual(parseGoalModelProposal(["```json", JSON.stringify(valid), "```"].join("\n"), ["knowledge_chunk:0"]), valid);
  assert.throws(() => parseGoalModelProposal(`Before the JSON:\n${JSON.stringify(valid)}`, ["knowledge_chunk:0"]));
  assert.throws(() => parseGoalModelProposal(JSON.stringify({ ...valid, planItems: [{ ...valid.planItems[0], assigneeUserId: assigneeId }] }), ["knowledge_chunk:0"]));
  assert.throws(() => parseGoalModelProposal(JSON.stringify({ ...valid, sourceKeys: ["knowledge_chunk:1"] }), ["knowledge_chunk:0"]), /unavailable/);
  assert.throws(() => parseGoalModelProposal(JSON.stringify({ ...valid, planItems: Array.from({ length: 13 }, () => valid.planItems[0]) }), ["knowledge_chunk:0"]));
  assert.throws(() => parseGoalModelProposal(JSON.stringify({ ...valid, extra: "execute" }), ["knowledge_chunk:0"]));
  assert.match(planningService, /untrusted_work_os_data/);
  assert.match(planningService, /searchCompanyKnowledge/);
  assert.match(planningService, /successCriteria: input\.goal\.success_criteria/);
  assert.match(planningService, /parseGoalModelProposal/);
  assert.doesNotMatch(planningService, /\.from\("work_items"\)\.insert/);
});

test("goal planning may request a bounded larger output budget without changing normal AI calls", async () => {
  const observed: number[] = [];
  const executor = createAiTextExecutor({ provider: "test", model: "test", timeoutMs: 1000,
    maxInputCharacters: 1000, maxOutputTokens: 1000,
    runModel: async ({ maxOutputTokens }) => { observed.push(maxOutputTokens); return { text: "ok" }; } });
  await executor({ instruction: "normal", content: "sample" });
  await executor({ instruction: "plan", content: "sample", maxOutputTokens: 2000 });
  await executor({ instruction: "oversized", content: "sample", maxOutputTokens: 999999 });
  assert.deepEqual(observed, [1000, 2000, 2000]);
});

test("manager plan editing validates assignments, order, dates, and item count", () => {
  const item = { title: "Review applications", assigneeUserId: assigneeId,
    dueAt: "2026-11-20T12:00:00Z", priority: "high" };
  assert.equal(GoalPlanEditSchema.parse({ goalId, expectedRevision: 0, items: [item] }).items[0].priority, "high");
  assert.equal(GoalPlanEditSchema.safeParse({ goalId, expectedRevision: 0, items: [] }).success, false);
  assert.equal(GoalPlanEditSchema.safeParse({ goalId, expectedRevision: 0, items: [{ ...item, assigneeUserId: "outside" }] }).success, false);
  assert.equal(GoalPlanEditSchema.safeParse({ goalId, expectedRevision: 0, items: [{ ...item, dueAt: "tomorrow" }] }).success, false);
});

test("only done counts toward progress; overdue and missing work remain visible", () => {
  assert.deepEqual(deriveGoalProgress([
    { status: "done", dueAt: "2026-10-01T00:00:00Z" },
    { status: "handled", dueAt: "2026-10-01T00:00:00Z" },
    { status: "needs_you", dueAt: "2026-10-03T00:00:00Z" }, null,
  ], now), { completed: 1, total: 4, needsAttention: 2, overdue: 1, missing: 1 });
});

test("goal routing and references stay inside authenticated workspace URLs", async () => {
  assert.deepEqual(selectAskTools("What goals are active?"), ["goals"]);
  assert.ok(selectAskTools("What do I need to do for the hiring goal?").includes("goals"));
  assert.ok(selectAskTools("Which goals have overdue work?").includes("goals"));
  assert.ok(!selectAskTools("Which workflows need attention?").includes("goals"));
  assert.equal(safeAuthReturnPath(`/goals/${goalId}`), `/goals/${goalId}`);
  assert.equal(safeAuthReturnPath("//evil.example/goals"), "/dashboard");
  const goalReference = { kind: "goal", entityId: goalId, label: "Hire 3 support agents", href: `/goals/${goalId}` };
  assert.equal(AskReferenceSchema.parse(goalReference).kind, "goal");
  assert.equal(AskReferenceSchema.safeParse({ ...goalReference, href: "https://other.example" }).success, false);
  const tool: AskToolResult = { tool: "goals", summary: "One workspace goal", records: [{
    referenceKey: "goal:0", reference: goalReference as AskToolResult["records"][number]["reference"],
    facts: { title: "Hire 3 support agents", status: "active",
      completedWorkItems: "1 of 3 linked plan Work Items marked done" },
  }] };
  const answer = await runGroundedAsk({ question: "How are we doing on the hiring goal?", history: [],
    loadTool: async () => tool,
    callModel: async () => JSON.stringify({ responseType: "answer", answer: "One of three linked Work Items is done.",
      referenceKeys: ["goal:0"], clarificationRequired: false }) });
  assert.equal(answer.metadata.references[0].href, `/goals/${goalId}`);
  assert.match(answer.answer, /1 of 3 linked plan Work Items marked done/);
  const misframed = await runGroundedAsk({ question: "How are we doing on the hiring goal?", history: [],
    loadTool: async () => tool,
    callModel: async () => JSON.stringify({ responseType: "answer", answer: "We completed 1 of the 3 hires.",
      referenceKeys: ["goal:0"], clarificationRequired: false }) });
  assert.match(misframed.answer, /1 of 3 linked plan Work Items marked done/);
  assert.doesNotMatch(misframed.answer, /3 hires/);
  assert.equal(misframed.metadata.references[0].href, `/goals/${goalId}`);
  await assert.rejects(runGroundedAsk({ question: "How are we doing on the hiring goal?", history: [],
    loadTool: async () => tool,
    callModel: async () => JSON.stringify({ responseType: "answer", answer: "All done", referenceKeys: ["goal:9"], clarificationRequired: false }) }));
});

test("Goal Activity is human-readable and links only to a scoped internal goal route", () => {
  const event = { event_type: "goal_activated", source_type: "goal", goal_id: goalId,
    visibility: "workspace" } as ActivityEvent;
  assert.match(activityLabel(event), /goal became active/i);
  assert.equal(activityOutcome(event), "Active");
  assert.equal(activitySourceHref(event), `/goals/${goalId}`);
});

test("migration confines mutation to service-only RPCs and atomic approved Work Item creation", () => {
  assert.match(migration, /^begin;/);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /force row level security/g);
  assert.match(migration, /revoke all on function public\.activate_goal_plan\(uuid, uuid, uuid, integer\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.activate_goal_plan\(uuid, uuid, uuid, integer\) to service_role/);
  assert.match(migration, /m\.role in \('owner', 'admin'\)/);
  assert.match(migration, /v_total <> v_valid/);
  assert.match(migration, /insert into public\.work_items/);
  assert.match(migration, /unique index work_items_goal_plan_item_unique/);
  assert.match(migration, /guard_goal_plan_immutability/);
  assert.match(migration, /on conflict \(workspace_id, event_key\) do nothing/);
  assert.match(goalService, /getAuthenticatedContext\(\)/);
  assert.match(goalService, /assertAssignee\(auth\.workspace\.id/);
  assert.doesNotMatch(goalService, /SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY/);
});
