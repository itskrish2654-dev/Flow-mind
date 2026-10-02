import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const projectRef = "gamdxwtgccluifatcrrs";
const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
const token = (await readFile(join(homedir(), ".supabase", "access-token"), "utf8")).trim();
assert.ok(token, "Supabase Management API access required");
const query = await readFile(new URL("./work-os-goals-acceptance.sql", import.meta.url), "utf8");
const response = await fetch(endpoint, { method: "POST", headers: {
  Authorization: `Bearer ${token}`, "Content-Type": "application/json",
}, body: JSON.stringify({ query }), signal: AbortSignal.timeout(60_000) });
if (!response.ok) {
  const payload = await response.json().catch(() => ({}));
  const diagnostic = String(payload.message ?? payload.error ?? "unknown database error")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 240);
  throw new Error(`Goals acceptance transaction failed (HTTP ${response.status}): ${diagnostic}`);
}
const result = await response.json();
assert.ok(Array.isArray(result) && result.some((row) => row.goals_runtime_acceptance === "PASS"),
  "Goals acceptance marker missing");
console.log("GOALS_RUNTIME_ACCEPTANCE=PASS; disposable SQL fixtures rolled back");
