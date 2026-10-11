import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { safeAuthReturnPath } from "../lib/auth-return-path";

const source = (path: string) => readFileSync(path, "utf8");

test("fresh signup and accepted invitations enter the guided company start without an open redirect", () => {
  const login = source("components/login-form.tsx");
  const auth = source("app/actions/auth.ts");
  const callback = source("app/auth/callback/route.ts");
  const invite = source("components/invite-acceptance.tsx");
  assert.equal(safeAuthReturnPath("/getting-started"), "/getting-started");
  assert.equal(safeAuthReturnPath("//evil.example/getting-started"), "/dashboard");
  assert.equal(safeAuthReturnPath("/getting-started#token"), "/dashboard");
  assert.match(login, /mode === "signup" && nextPath === "\/dashboard" \? "\/getting-started" : nextPath/);
  assert.match(auth, /emailRedirectTo:.*safeAuthReturnPath\(parsed\.data\.nextPath\)/);
  assert.match(callback, /safeAuthReturnPath\(requestedNext\)/);
  assert.match(invite, /router\.replace\("\/getting-started"\)/);
});

test("owner setup uses existing company, knowledge and Goal services with optional connections", () => {
  const page = source("app/getting-started/page.tsx");
  for (const service of ["getCompanyAdministration", "listCompanyKnowledge", "listWorkspaceGoals"]) {
    assert.match(page, new RegExp(service));
  }
  for (const destination of ["/settings/company", "/knowledge", "/goals", "/connections", "/my-day"]) {
    assert.ok(page.includes(destination));
  }
  assert.match(page, /optional: true/);
  assert.match(page, /role !== "member"/);
  assert.match(page, /We couldn’t check your setup right now/);
  assert.doesNotMatch(page, /createAdminClient|service_role|\.from\("workspace_invitations"\)/);
});

test("employee arrival and ongoing help explain work, approval, and privacy boundaries", () => {
  const page = source("app/getting-started/page.tsx");
  const guide = source("components/pilot-guide.tsx");
  const navigation = source("app/dashboard/layout.tsx");
  assert.match(page, /Go to My Day/);
  for (const term of ["My Day", "A Goal", "Ask CrazyLoops", "Do with AI", "Automate This", "Approvals"]) {
    assert.ok(guide.includes(term));
  }
  assert.match(guide, /do not automatically see your private Ask conversations, Gmail, or unfinished AI drafts/);
  assert.match(navigation, /href="\/getting-started"/);
});

test("first-run recovery and shared-source failures use human guidance without raw processing errors", () => {
  const page = source("app/getting-started/page.tsx");
  const knowledge = source("app/knowledge/page.tsx");
  const connections = source("app/connections/page.tsx");
  assert.match(page, /We couldn’t load your workspace right now/);
  assert.match(knowledge, /remove it and upload a supported file again/);
  assert.doesNotMatch(knowledge, /\{document\.failure_reason/);
  assert.match(connections, /Connect only the apps your work needs/);
});

test("pilot milestone telemetry contains names and no private content properties", () => {
  const observability = source("lib/observability.ts");
  for (const name of ["workspace_created", "employee_invited", "employee_activated", "goal_created",
    "goal_plan_approved", "work_items_assigned", "my_day_viewed", "ask_used", "do_with_ai_used",
    "deliverable_finalized", "task_completed", "automate_this_suggested", "automation_activated",
    "external_action_approved", "external_action_executed"]) {
    assert.ok(observability.includes(`"${name}"`), name);
  }
  assert.match(observability, /PRIVATE_METADATA_KEY[\s\S]*prompt\|submission\|input\|output\|content/);
  assert.doesNotMatch(source("app/getting-started/page.tsx"), /trackProductEvent\([\s\S]*properties:/);
  assert.match(source("lib/workspace-context.ts"), /recordNewAccountWorkspace[\s\S]*resolveTrustedWorkspaceMembership[\s\S]*workspace_created/);
});
