import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = async (file: string) => readFile(file, "utf8");

test("launch UX exposes only Workflow and Activity as primary project views", async () => {
  const project = await source("components/project-workspace.tsx");
  assert.match(project, /aria-label="Project views"/);
  assert.match(project, />\s*Workflow\s*</);
  assert.match(project, />\s*Activity\s*/);
  assert.doesNotMatch(project, />\s*Versions\s*</);
  assert.doesNotMatch(project, /Executions &amp; Data/);
  assert.match(project, /Change history/);
  assert.match(project, /aria-pressed=\{historyOpen\}/);
  assert.match(project, /setView\("activity"\)/);
});

test("Activity list prioritizes customer status, run type, time, trigger, and result", async () => {
  const activity = await source("components/executions-data-table.tsx");
  assert.match(activity, /See what your loop has done\./);
  for (const label of ["Status", "Run", "When", "What started it", "Result", "View details"]) {
    assert.match(activity, new RegExp(label));
  }
  for (const status of ["Success", "Failed", "Running"]) assert.match(activity, new RegExp(`"${status}"`));
  assert.match(activity, /Test run/);
  assert.match(activity, /Live run/);
  assert.match(activity, /Started by a public form submission/);
  assert.match(activity, /Started by a connected app event/);
  assert.match(activity, /Started by its schedule/);
  assert.match(activity, /humanTimestamp\(execution\.createdAt\)/);
});

test("Activity details use a customer timeline and keep technical data collapsed", async () => {
  const activity = await source("components/executions-data-table.tsx");
  assert.match(activity, /title="Run details"/);
  for (const section of ["What happened", "Result", "Submitted data", "AI result", "Documents", "Technical details"]) {
    assert.match(activity, new RegExp(section));
  }
  assert.match(activity, /<ol className=/);
  assert.match(activity, /<details className=/);
  assert.match(activity, /Stopped at:/);
  assert.match(activity, /Retry stopped step/);
  assert.doesNotMatch(activity, />\s*Processing log\s*</);
  assert.doesNotMatch(activity, /result\.body\.slice/);
});

test("Activity empty state and responsive progressive disclosure match launch copy", async () => {
  const activity = await source("components/executions-data-table.tsx");
  assert.match(activity, /No activity yet\./);
  assert.match(activity, /Test your loop or activate it to see what happens here\./);
  assert.match(activity, /space-y-3 lg:space-y-0/);
  assert.match(activity, /lg:grid-cols-/);
  assert.doesNotMatch(activity, /overflow-x-auto rounded-2xl/);
});

test("Change history is humanized, grouped, and restores without deleting newer history", async () => {
  const [history, action] = await Promise.all([
    source("components/workflow-version-history.tsx"),
    source("app/actions/versions.ts"),
  ]);
  assert.match(history, /CrazyLoops saves previous setups automatically, so you can undo a change without losing your history\./);
  for (const label of [
    "Updated loop setup",
    "Changed destination",
    "Changed how the loop starts",
    "Changed form",
    "Changed schedule",
    "Updated configuration",
  ]) assert.match(history, new RegExp(label));
  assert.match(history, /Current setup/);
  assert.match(history, /Earlier setups/);
  assert.match(history, /Restore this setup\?/);
  assert.match(history, /This earlier setup will become current\. Every newer setup will stay in your change history\./);
  assert.match(history, /> Restore this setup/);
  assert.doesNotMatch(history, /v\{version\.versionNumber\}/);
  assert.match(action, /createImmutableWorkflowVersion/);
  assert.match(action, /sourceVersionId: request\.data\.sourceVersionId/);
  assert.doesNotMatch(action, /from\("workflow_versions"\)[\s\S]{0,80}\.delete/);
});

test("Change history first-setup state is explicit", async () => {
  const history = await source("components/workflow-version-history.tsx");
  assert.match(history, /Your current setup is the first version\./);
  assert.match(history, /Future changes will appear here automatically\./);
});

test("existing ownership boundaries remain on Activity and restore reads", async () => {
  const [executions, versions] = await Promise.all([
    source("app/actions/executions.ts"),
    source("app/actions/versions.ts"),
  ]);
  assert.match(executions, /getAuthenticatedContext\(\)/);
  assert.match(executions, /\.eq\("user_id", auth\.user\.id\)/);
  assert.match(versions, /getAuthenticatedContext\(\)/);
  assert.match(versions, /\.eq\("workflow_id", id\.data\)/);
  assert.match(versions, /\.eq\("user_id", auth\.user\.id\)/);
  assert.match(versions, /\.eq\("workflow_id", request\.data\.workflowId\)/);
  assert.match(versions, /\.eq\("user_id", auth\.user\.id\)/);
});

test("customer-facing links and generated store descriptions use Activity terminology", async () => {
  const [workspace, compiler] = await Promise.all([
    source("components/automation-workspace.tsx"),
    source("lib/workflow-compiler.ts"),
  ]);
  assert.match(workspace, /View Activity/);
  assert.doesNotMatch(workspace, /View Executions &amp; Data/);
  assert.match(compiler, /completed results in Activity/);
});
