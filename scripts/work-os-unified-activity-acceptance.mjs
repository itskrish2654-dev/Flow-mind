import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = "gamdxwtgccluifatcrrs";
const endpoint = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const token = (await readFile(join(homedir(), ".supabase", "access-token"), "utf8")).trim();
assert.ok(token, "Supabase Management API access is required");
const query = process.argv.includes("--baseline")
  ? `select (select count(*) from auth.users) as auth_users,
      (select count(*) from public.workspaces) as workspaces,
      (select count(*) from public.workspace_memberships) as memberships,
      (select count(*) from public.work_items) as work_items,
      (select count(*) from public.approval_requests) as approvals,
      (select count(*) from public.action_executions) as actions,
      (select count(*) from public.activity_events) as activity_events`
  : await readFile(new URL("./work-os-unified-activity-acceptance.sql", import.meta.url), "utf8");
const response = await fetch(endpoint, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query }),
  signal: AbortSignal.timeout(45_000),
});
if (!response.ok) {
  const payload = await response.json().catch(() => ({}));
  const diagnostic = String(payload.message ?? payload.error ?? "unknown database error")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(0, 240);
  throw new Error(`Activity acceptance database transaction failed (HTTP ${response.status}): ${diagnostic}`);
}
const result = await response.json();
if (process.argv.includes("--baseline")) {
  console.log(JSON.stringify(result));
  process.exit(0);
}
assert.ok(Array.isArray(result) && result.some((row) => row.activity_runtime_acceptance === "PASS"),
  "Activity acceptance did not return its completion marker");
console.log("ACTIVITY_RUNTIME_ACCEPTANCE=PASS; all disposable SQL fixtures rolled back");
