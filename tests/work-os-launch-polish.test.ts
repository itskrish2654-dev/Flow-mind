import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = (path: string) => readFileSync(path, "utf8");

test("polish auth deduplicates per server render without persistent identity caching", () => {
  const auth = source("lib/auth.ts");
  assert.match(auth, /import \{ cache \} from "react"/);
  assert.match(auth, /getAuthenticatedContext = cache\(async function/);
  assert.match(auth, /supabase\.auth\.getUser\(\)/);
  assert.match(auth, /resolveTrustedWorkspaceMembership\(user\.id\)/);
  assert.doesNotMatch(auth, /unstable_cache|use cache|new Map|localStorage/);
});
test("page-view analytics run after the response without delaying work screens", () => {
  for (const path of ["app/my-day/page.tsx", "app/dashboard/page.tsx"]) {
    const page = source(path);
    assert.match(page, /import \{ after \} from "next\/server"/);
    assert.match(page, /after\(\(\) => trackProductEvent\(/);
    assert.doesNotMatch(page, /await trackProductEvent\(/);
  }
});
test("work navigation uses trusted role presentation and avoids unrelated readiness fetches", () => {
  const navigation = source("app/dashboard/layout.tsx");
  const role = source("app/actions/workspace-navigation.ts");
  assert.match(role, /getAuthenticatedContext\(\)/);
  assert.match(role, /auth\?\.membership\.role \?\? null/);
  assert.doesNotMatch(role, /createAdminClient|secret|credentials|workspaceId/);
  assert.match(navigation, /if \(!showingWorkflows\) return/);
  assert.equal((navigation.match(/workspaceRole === "owner" \|\| workspaceRole === "admin"/g) ?? []).length, 2);
  assert.equal((navigation.match(/href="\/manager"/g) ?? []).length, 2);
  for (const path of ["/my-day", "/ask", "/activity", "/automations", "/dashboard", "/connections", "/knowledge", "/goals"]) assert.ok(navigation.includes(path));
});
test("AI loading is truthful and interruption recovery does not automatically resubmit", () => {
  const manager = source("components/goals/goal-manager.tsx");
  assert.match(manager, /finally \{ setPending\(false\)/);
  assert.match(manager, /Refresh to check the saved state before trying again/);
  assert.match(manager, /Preparing an AI proposal/);
  const button = source("components/workspace/pending-submit.tsx");
  assert.match(button, /useFormStatus/);
  assert.match(button, /disabled=\{pending\}/);
  assert.match(button, /role="status"/);
  assert.doesNotMatch(button, /setTimeout|setInterval|fetch\(/);
});
test("loading boundaries preserve fresh authorization and reveal no previous user's content", () => {
  for (const path of ["my-day", "manager", "goals", "ask", "automations", "knowledge", "getting-started", "activity"]) {
    assert.match(source(`app/${path}/loading.tsx`), /WorkspaceLoading/);
  }
  const loading = source("components/workspace/loading.tsx");
  assert.match(loading, /Checking your current access/);
  assert.doesNotMatch(loading, /localStorage|sessionStorage|fetch\(|userId/);
});
test("homepage pilot enquiries use one existing contact, with an honest email handoff", () => {
  const home = source("components/launch-home.tsx");
  assert.equal((home.match(/href=\{pilotHref\}/g) ?? []).length, 3);
  assert.match(home, /getSupportEmail\(\)/);
  assert.match(home, /Opens your email app/);
  assert.match(home, /encodeURIComponent/);
  assert.match(home, /Illustrative workspace/);
  assert.match(home, /href="\/dashboard"/);
  assert.doesNotMatch(home, /self.host|autonomously|guaranteed|testimonial|SOC 2|10X/i);
});
