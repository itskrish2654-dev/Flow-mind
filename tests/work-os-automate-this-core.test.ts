import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { detectRepeatedWork, isFollowUpWorkTitle, matchingAutomationWorkItem } from "../lib/automate-this-core";
import { AutomationConfigurationSchema, compileAutomationSuggestion, isReviewedAutomateThisWorkflow } from "../lib/automate-this-plan";

const now = new Date("2026-10-10T12:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ai = (n: number, title = "Prepare manager status update") => ({
  workItemId: uuid(n), kind: "work_item_ai_result" as const, sourceType: "internal",
  title, completedAt: `2026-10-0${n}T12:00:00.000Z`,
});

test("three distinct completed instances of the same task create one explainable pattern", () => {
  const patterns = detectRepeatedWork([ai(1), ai(2), ai(3), ai(3)], now);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].count, 3);
  assert.equal(patterns[0].workItemIds.length, 3);
  assert.match(patterns[0].explanation, /3 AI-assisted results/);
});

test("one action, different tasks, source types, and stale events never become a pattern", () => {
  assert.equal(detectRepeatedWork([ai(1)], now).length, 0);
  assert.equal(detectRepeatedWork([ai(1), ai(2, "Draft a client proposal"), ai(3)], now).length, 0);
  assert.equal(detectRepeatedWork([ai(1), ai(2), { ...ai(3), sourceType: "connector_event" }], now).length, 0);
  assert.equal(detectRepeatedWork([ai(1), ai(2), { ...ai(3), completedAt: "2026-09-01T12:00:00.000Z" }], now).length, 0);
});

test("Gmail follow-up and AI result patterns cannot be combined", () => {
  const evidence = [ai(1), ai(2), { ...ai(3), kind: "gmail_follow_up" as const }];
  assert.equal(detectRepeatedWork(evidence, now).length, 0);
  const followUps = [1, 2, 3].map((n) => ({ ...ai(n), kind: "gmail_follow_up" as const }));
  assert.match(detectRepeatedWork(followUps, now)[0].explanation, /approved and sent 3 Gmail follow-ups/);
});

test("only a proven follow-up Workbench handoff can be classified as Gmail follow-up", () => {
  assert.equal(isFollowUpWorkTitle("Customer has not replied"), true);
  assert.equal(isFollowUpWorkTitle("Send quarterly report"), false);
  assert.equal(detectRepeatedWork([ai(1), ai(2), { ...ai(3), sourceType: "workflow_execution" }], now).length, 0);
});

test("future matching Work Items require the exact reviewed source and published boundary", () => {
  const expected = { title: "Prepare manager status update", sourceType: "internal" };
  const input = { ...expected, status: "needs_you", createdAt: "2026-10-10T11:00:00Z",
    dueAt: null, publishedAt: "2026-10-10T10:00:00Z", now, waitDays: null };
  assert.equal(matchingAutomationWorkItem(input, expected), true);
  assert.equal(matchingAutomationWorkItem({ ...input, title: "Prepare a manager status update" }, expected), false);
  assert.equal(matchingAutomationWorkItem({ ...input, sourceType: "connector_event" }, expected), false);
  assert.equal(matchingAutomationWorkItem({ ...input, createdAt: "2026-10-10T09:59:59Z" }, expected), false);
  assert.equal(matchingAutomationWorkItem({ ...input, status: "done" }, expected), false);
});

test("Gmail follow-up must still be waiting, due, and old enough; no reply inference", () => {
  const expected = { title: "Customer has not replied", sourceType: "internal" };
  const input = { ...expected, status: "waiting", createdAt: "2026-10-06T10:00:00Z",
    dueAt: "2026-10-09T10:00:00Z", publishedAt: "2026-10-01T00:00:00Z", now, waitDays: 3 };
  assert.equal(matchingAutomationWorkItem(input, expected), true);
  assert.equal(matchingAutomationWorkItem({ ...input, status: "done" }, expected), false);
  assert.equal(matchingAutomationWorkItem({ ...input, dueAt: null }, expected), false);
  assert.equal(matchingAutomationWorkItem({ ...input, dueAt: "2026-10-12T00:00:00Z" }, expected), false);
  assert.equal(matchingAutomationWorkItem({ ...input, createdAt: "2026-10-09T00:00:00Z" }, expected), false);
});

test("reviewed proposal compiles into preparation only and never an external send", () => {
  const suggestion = { pattern_kind: "gmail_follow_up" as const,
    source_title: "Customer has not replied", source_type: "internal" as const };
  const configuration = AutomationConfigurationSchema.parse({ kind: "gmail_follow_up",
    matchTitle: suggestion.source_title, sourceType: suggestion.source_type,
    instruction: "Prepare a polite follow-up from the Work Item details only.",
    waitDays: 3, gmailConnectionId: uuid(1), recipientEmail: "customer@example.com",
    subject: "Following up" });
  const workflow = compileAutomationSuggestion(suggestion, configuration);
  assert.equal(isReviewedAutomateThisWorkflow(workflow), true);
  assert.deepEqual(workflow.steps.map((step) => step.capabilityId), ["work_item_trigger", "ai_text_transform", "flowmind_data_store"]);
  assert.equal(workflow.steps.some((step) => step.capabilityId === "gmail_send_email" || step.type === "connector_action"), false);
  assert.throws(() => compileAutomationSuggestion(suggestion, { ...configuration, matchTitle: "Different title" }));
});

test("the dispatch adapter closes expired runs visibly instead of replaying an uncertain outcome", () => {
  const source = readFileSync(new URL("../lib/automate-this-dispatch.ts", import.meta.url), "utf8");
  assert.match(source, /async function reconcileExpiredRuns\(now: Date\)/);
  assert.match(source, /\.eq\("status", "running"\)\.lt\("lease_until", now\.toISOString\(\)\)/);
  assert.match(source, /failure_category: "interrupted_execution"/);
  assert.match(source, /await recordRunFailure\(run\)/);
  assert.match(source, /source_type: "system"[\s\S]*?status: "needs_you"/);
  const reconciliation = source.slice(source.indexOf("async function reconcileExpiredRuns"),
    source.indexOf("async function executeRun"));
  assert.doesNotMatch(reconciliation, /executeRun\(/);
});
