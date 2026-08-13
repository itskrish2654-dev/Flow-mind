import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { redactForLog, redactText } from "../lib/security/redaction";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("6-1. reconciliation cron requires a constant-time CRON_SECRET authorization check", async () => {
  const route = await source("app/api/operations/maintenance/route.ts");
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /status: 401/);
  assert.match(route, /run_operational_maintenance/);
});

test("6-2. maintenance is overlap-safe and stale reconciliation remains idempotent", async () => {
  const migration = await source("supabase/migrations/20260813000100_phase6_operations.sql");
  const executionMigration = await source("supabase/migrations/20260812000100_phase3_execution_reliability.sql");
  assert.match(migration, /pg_try_advisory_xact_lock/);
  assert.match(migration, /overlapping_run/);
  assert.match(migration, /fail_stale_executions\(p_stale_before\)/);
  assert.match(executionMigration, /where status in \('queued', 'running'\)/i);
});

test("6-3. rate-limit cleanup cannot delete an active window", async () => {
  const migration = await source("supabase/migrations/20260813000100_phase6_operations.sql");
  assert.match(migration, /window_started_at \+ make_interval\(secs => window_seconds\) < p_rate_limit_retention_before/);
});

test("6-4. concurrency maintenance removes only expired leases", async () => {
  const migration = await source("supabase/migrations/20260813000100_phase6_operations.sql");
  assert.match(migration, /security_concurrency_leases[\s\S]*where expires_at < clock_timestamp\(\)/);
});

test("6-5. failed deletion reconciliation stays fail-closed and bounded", async () => {
  const maintenance = await source("lib/account-deletion-maintenance.ts");
  assert.match(maintenance, /\.eq\("state", "failed"\)/);
  assert.match(maintenance, /\.lt\("retry_count", 5\)/);
  assert.match(maintenance, /\.eq\("retry_count", job\.retry_count\)/);
  assert.match(maintenance, /public forms remain disabled|cleanup_account_data/);
  assert.match(maintenance, /account_deletion_reconciliation_failed/);
});

test("6-6. log redaction removes authentication and secret material", () => {
  const redacted = redactForLog({
    password: "do-not-log",
    authorization: "Bearer secret-token",
    nested: { apiKey: "secret", safe: "ok" },
  }) as Record<string, unknown>;
  assert.equal(redacted.password, "[REDACTED]");
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.deepEqual(redacted.nested, { apiKey: "[REDACTED]", safe: "ok" });
  assert.doesNotMatch(redactText("Bearer abc.def.ghi"), /abc\.def\.ghi/);
});

test("6-7. monitoring captures unhandled server errors with sanitized context", async () => {
  const instrumentation = await source("instrumentation.ts");
  const observability = await source("lib/observability.ts");
  const credentials = await source("app/actions/credentials.ts");
  assert.match(instrumentation, /onRequestError/);
  assert.match(instrumentation, /captureOperationalError/);
  assert.match(observability, /sanitizeOperationalMetadata/);
  assert.match(observability, /PRIVATE_METADATA_KEY/);
  assert.match(observability, /operational_events/);
  assert.match(credentials, /credential_vault_failed/);
});

test("6-8. analytics is allowlisted and rejects private payload categories", async () => {
  const analytics = await source("lib/observability.ts");
  assert.match(analytics, /SAFE_ANALYTICS_KEYS/);
  assert.match(analytics, /product_analytics_events/);
  assert.doesNotMatch(analytics, /SAFE_ANALYTICS_KEYS[\s\S]{0,600}["']prompt["']/);
  assert.doesNotMatch(analytics, /SAFE_ANALYTICS_KEYS[\s\S]{0,600}["']email["']/);
});

test("6-9. health endpoint is minimal, no-store, and does not expose versions or secrets", async () => {
  const health = await source("app/api/health/route.ts");
  assert.match(health, /Cache-Control.*no-store/);
  assert.match(health, /status: "ok"/);
  assert.match(health, /status: 503/);
  assert.doesNotMatch(health, /SUPABASE_SECRET_KEY|GROQ_API_KEY|process\.versions/);
});

test("6-10. no temporary acceptance or debug route exists", async () => {
  const routeFiles = (await readdir(new URL("../app/", import.meta.url), { recursive: true }))
    .filter((file) => /route\.tsx?$/.test(file));
  for (const file of routeFiles) {
    assert.doesNotMatch(file, /acceptance|debug|internal-test|smoke|fixture|temporary/i);
  }
});

test("6-11. environment inventory uses only modern Supabase key names", async () => {
  const env = await source(".env.example");
  assert.match(env, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=/);
  assert.match(env, /SUPABASE_SECRET_KEY=/);
  assert.match(env, /CRON_SECRET=/);
  assert.doesNotMatch(env, new RegExp("NEXT_PUBLIC_SUPABASE_" + "ANON_KEY"));
  assert.doesNotMatch(env, new RegExp("SUPABASE_" + "SERVICE_ROLE_KEY"));
});

test("6-12. active production code contains no obsolete product branding", async () => {
  const active = await Promise.all([
    source("app/layout.tsx"),
    source("app/login/page.tsx"),
    source("app/privacy/page.tsx"),
    source("app/terms/page.tsx"),
    source("README.md"),
  ]);
  const obsolete = new RegExp("Flow" + "Pilot|flow" + "pilot\\.dev", "i");
  for (const file of active) assert.doesNotMatch(file, obsolete);
});

test("6-13. secret scanning covers modern and legacy privileged credentials", async () => {
  const config = await source(".gitleaks.toml");
  assert.match(config, /supabase-secret-key/);
  assert.match(config, /groq-api-key/);
  assert.match(config, /legacy-supabase-service-role-jwt/);
  assert.match(config, /flowmind-master-key-assignment/);
  assert.match(config, /turnstile-secret-assignment/);
});

test("6-14. CI fails on regressions, build failures, E2E failures, or secret findings", async () => {
  const ci = await source(".github/workflows/ci.yml");
  for (const command of [
    "npm ci",
    "npm test",
    "npx tsc --noEmit",
    "npm run lint",
    "npm run build",
    "npm run test:e2e",
  ]) assert.match(ci, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(ci, /gitleaks-action/);
});

test("6-15. Supabase reconciles every ten minutes and Vercel runs application cleanup daily", async () => {
  const config = JSON.parse(await source("vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
  const cronMigration = await source("supabase/migrations/20260813000200_phase6_cron_schedule.sql");
  assert.deepEqual(config.crons, [{ path: "/api/operations/maintenance", schedule: "5 3 * * *" }]);
  assert.match(cronMigration, /flowmind-operational-maintenance/);
  assert.match(cronMigration, /'\*\/10 \* \* \* \*'/);
  assert.match(cronMigration, /run_operational_maintenance/);
});

test("6-16. user-facing unhandled errors show a safe support reference", async () => {
  const errorPage = await source("app/error.tsx");
  assert.match(errorPage, /Reference:/);
  assert.match(errorPage, /error\.digest\.slice\(0, 12\)/);
  assert.doesNotMatch(errorPage, /error\.stack/);
});
