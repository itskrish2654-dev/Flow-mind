import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canReadWorkbenchRecord, classifyWorkMode, parseWorkbenchModelResult,
  WorkbenchGenerateSchema, WorkbenchSaveSchema } from "../lib/workbench-core";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("task classification routes assistance without making separate agents", () => {
  assert.equal(classifyWorkMode("Research three competitors"), "RESEARCH");
  assert.equal(classifyWorkMode("Draft an update for the manager"), "WRITING");
  assert.equal(classifyWorkMode("Prepare launch update Use authorized Acme launch context Prepare a useful first draft for this task. Flag gaps in the available context."), "WRITING");
  assert.equal(classifyWorkMode("Analyze the selected spreadsheet"), "DATA");
  assert.equal(classifyWorkMode("Review TypeScript code"), "CODING");
  assert.equal(classifyWorkMode("Prepare campaign messaging"), "MARKETING");
  assert.equal(classifyWorkMode("Finish this assigned item"), "GENERAL");
});

test("model result cites only actually supplied company sections", () => {
  const valid = parseWorkbenchModelResult(JSON.stringify({ title: "Competitor comparison",
    content: "The provided section describes one competitor. Two remain unverified.",
    sourceKeys: ["knowledge_chunk:0"] }), ["knowledge_chunk:0"]);
  assert.equal(valid.sourceKeys[0], "knowledge_chunk:0");
  assert.throws(() => parseWorkbenchModelResult(JSON.stringify({ title: "Fabrication", content: "Claim",
    sourceKeys: ["knowledge_chunk:1"] }), ["knowledge_chunk:0"]));
  assert.throws(() => parseWorkbenchModelResult(JSON.stringify({ title: "Duplicate", content: "Claim",
    sourceKeys: ["knowledge_chunk:0", "knowledge_chunk:0"] }), ["knowledge_chunk:0"]));
  assert.throws(() => parseWorkbenchModelResult(JSON.stringify({ title: "Action", content: "Claim",
    sourceKeys: [], executed: true }), []));
  assert.throws(() => parseWorkbenchModelResult(JSON.stringify({ title: "False delivery",
    content: "I sent the email to your manager.", sourceKeys: [] }), []));
});

test("browser inputs cannot inject owner, workspace, or final status", () => {
  assert.equal(WorkbenchGenerateSchema.safeParse({ workItemId: uuid(1), requestKey: uuid(2),
    instruction: "Prepare the brief", workspaceId: uuid(3) }).success, false);
  assert.equal(WorkbenchSaveSchema.safeParse({ workItemId: uuid(1), requestKey: uuid(2),
    title: "Brief", content: "Reviewed", status: "final" }).success, false);
});

test("employee scratch stays private; only final goal deliverables reach managers", () => {
  const base = { ownerUserId: uuid(1), viewerUserId: uuid(2), viewerRole: "admin" as const,
    sameWorkspace: true, goalId: uuid(3), stillAssigned: false };
  assert.equal(canReadWorkbenchRecord({ ...base, kind: "turn", status: "completed" }), false);
  assert.equal(canReadWorkbenchRecord({ ...base, kind: "deliverable", status: "draft" }), false);
  assert.equal(canReadWorkbenchRecord({ ...base, kind: "deliverable", status: "final" }), true);
  assert.equal(canReadWorkbenchRecord({ ...base, kind: "deliverable", status: "final", sameWorkspace: false }), false);
  assert.equal(canReadWorkbenchRecord({ ...base, kind: "deliverable", status: "final", viewerRole: "member" }), false);
  assert.equal(canReadWorkbenchRecord({ ...base, kind: "deliverable", status: "final", goalId: null }), false);
  assert.equal(canReadWorkbenchRecord({ ...base, kind: "turn", status: "completed",
    ownerUserId: uuid(2), stillAssigned: true }), true);
});

test("migration grants reads only and isolates private turns from manager final results", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261009152851_work_os_employee_ai_workbench.sql", import.meta.url), "utf8");
  assert.match(sql, /begin;[\s\S]*commit;/i);
  assert.match(sql, /work_item_ai_turns_private_read[\s\S]*owner_user_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /work_item_deliverables_read[\s\S]*status = 'final'/);
  assert.match(sql, /m\.role in \('owner','admin'\)/);
  assert.match(sql, /revoke all on public\.work_item_ai_turns, public\.work_item_deliverables from public, anon, authenticated/);
  assert.match(sql, /grant select on public\.work_item_ai_turns, public\.work_item_deliverables to authenticated/);
  assert.doesNotMatch(sql, /grant (insert|update|delete) on public\.work_item_ai_turns, public\.work_item_deliverables to authenticated/);
  assert.match(sql, /Final deliverable content is immutable/);
});
