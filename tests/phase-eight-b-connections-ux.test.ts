import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Connections is a first-class authenticated route with a backward-compatible settings redirect", async () => {
  const [layout, page, legacy, shell, dashboard] = await Promise.all([
    readFile("app/connections/layout.tsx", "utf8"),
    readFile("app/connections/page.tsx", "utf8"),
    readFile("app/settings/connections/page.tsx", "utf8"),
    readFile("components/settings-shell.tsx", "utf8"),
    readFile("app/dashboard/layout.tsx", "utf8"),
  ]);
  assert.match(layout, /login\?next=\/connections/);
  assert.match(page, /Connections/);
  assert.match(legacy, /redirect\(`\/connections/);
  assert.match(shell, /href="\/connections"/);
  assert.match(dashboard, /href="\/connections"/);
});

test("dashboard offers compact connected and new-user connection states", async () => {
  const workspace = await readFile("components/automation-workspace.tsx", "utf8");
  assert.match(workspace, /Connected apps/i);
  assert.match(workspace, /Connect the tools you already use/);
  assert.match(workspace, /CrazyLoops can build better loops/);
  assert.match(workspace, /Manage connections/);
  assert.match(workspace, /Reconnect required/);
});

test("connection rows expose real labels, health, multiple accounts, and focused management", async () => {
  const [component, loader] = await Promise.all([
    readFile("components/connections-list.tsx", "utf8"),
    readFile("lib/connectors/connection-view.ts", "utf8"),
  ]);
  assert.match(loader, /external_account_label/);
  assert.match(loader, /safeAccountLabel/);
  assert.match(loader, /\^T\[A-Z0-9\]/);
  assert.match(loader, /last_refreshed_at/);
  assert.match(loader, /usedByWorkflows/);
  assert.match(component, /Healthy/);
  assert.match(component, /Reconnect required/);
  assert.match(component, /Connect another/);
  assert.match(component, /Manage .* connection/);
  assert.match(component, /Disconnect .*\?/);
  assert.match(component, /will require reconnection/);
  assert.doesNotMatch(component, /external_account_id|granted_scopes|client ID|OAuth scopes/i);
});

test("Google remains Early Access while built-in capabilities are clearly account-free", async () => {
  const page = await readFile("app/connections/page.tsx", "utf8");
  const component = await readFile("components/connections-list.tsx", "utf8");
  for (const capability of ["Webhook", "HTTP JSON", "Hosted Forms", "AI", "PDF", "CrazyLoops Storage"]) {
    assert.match(page, new RegExp(capability));
  }
  assert.match(component, /Gmail/);
  assert.match(component, /Google Sheets/);
  assert.match(component, /Early Access/);
  assert.doesNotMatch(component, /Connect Gmail|Connect Google Sheets/);
});

test("workflow missing-connection CTAs preserve the originating project route", async () => {
  const workspace = await readFile("components/automation-workspace.tsx", "utf8");
  const oauth = await readFile("lib/connectors/oauth-return.ts", "utf8");
  assert.match(workspace, /needs to be connected/);
  assert.match(workspace, /workflowReturnPath = workflowId/);
  assert.match(workspace, /step=\$\{encodeURIComponent\(step\.id\)\}/);
  assert.match(workspace, /return=\$\{encodeURIComponent\(workflowReturnPath\)\}/);
  assert.match(oauth, /return "\/connections"/);
});

test("connection controls retain mobile touch targets and accessible labels", async () => {
  const component = await readFile("components/connections-list.tsx", "utf8");
  assert.match(component, /min-h-11/);
  assert.match(component, /aria-label={`Manage/);
  assert.match(component, /aria-label={`Reconnect/);
  assert.match(component, /aria-label={`Connect another/);
  assert.match(component, /side="right"/);
  assert.doesNotMatch(component, /overflow-x-auto/);
});
