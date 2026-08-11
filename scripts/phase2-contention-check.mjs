import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function loadEnv(path) {
  const values = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

const envPath = process.argv[2];
assert(envPath, "Usage: node scripts/phase2-contention-check.mjs <production-env-file>");
const env = loadEnv(envPath);
const rawUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
assert(rawUrl && serviceKey, "Production Supabase URL/service-role environment is unavailable.");
const supabaseUrl = rawUrl.replace(/\/rest\/v1\/?$/, "");
const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const runId = randomUUID();
const email = `phase21-contention-${runId}@example.com`;
const password = `${randomUUID()}Aa1!`;
const leasePrefix = `phase21:${runId}`;
const period = `${new Date().toISOString().slice(0, 7)}-01`;
let userId = null;
const results = {};

async function acquire(key, leaseId, limit = 1, ttl = 30) {
  return requireData(await admin.rpc("acquire_security_concurrency", {
    p_key_hash: key,
    p_lease_id: leaseId,
    p_limit: limit,
    p_ttl_seconds: ttl,
  }), "acquire concurrency lease");
}

async function release(key, leaseId) {
  requireData(await admin.rpc("release_security_concurrency", {
    p_key_hash: key,
    p_lease_id: leaseId,
  }), "release concurrency lease");
}

async function consume(metric, limit) {
  const data = requireData(await admin.rpc("consume_usage_quota", {
    p_user_id: userId,
    p_metric: metric,
    p_amount: 1,
    p_limit: limit,
    p_period_started_at: period,
  }), `consume ${metric} quota`);
  return data?.[0];
}

try {
  const created = requireData(await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  }), "create disposable user");
  userId = created.user.id;

  for (let index = 0; index < 24; index += 1) {
    requireData(await admin.rpc("create_workflow_with_quota", {
      p_user_id: userId,
      p_name: `Phase 2 contention ${index + 1}`,
      p_prompt: "Disposable security acceptance fixture",
      p_compiled_steps: { version: 1, steps: [] },
      p_limit: 25,
    }), "seed workflow");
  }

  const workflowRace = await Promise.all(Array.from({ length: 10 }, (_, index) =>
    admin.rpc("create_workflow_with_quota", {
      p_user_id: userId,
      p_name: `Phase 2 race ${index + 1}`,
      p_prompt: "Disposable security acceptance race",
      p_compiled_steps: { version: 1, steps: [] },
      p_limit: 25,
    }),
  ));
  const workflowIds = workflowRace.map((item, index) => requireData(item, `workflow race ${index + 1}`));
  const { count: exactWorkflowCount, error: countError } = await admin
    .from("workflows")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (countError) throw new Error(`count workflows: ${countError.message}`);
  results.workflowBoundary = {
    admitted: workflowIds.filter(Boolean).length,
    rejected: workflowIds.filter((id) => !id).length,
    finalCount: exactWorkflowCount,
  };
  assert(results.workflowBoundary.admitted === 1, "Workflow race admitted more or fewer than one request.");
  assert(results.workflowBoundary.rejected === 9 && exactWorkflowCount === 25, "Workflow boundary exceeded 25.");

  const executionKey = `${leasePrefix}:execution`;
  const executionAttempts = await Promise.all(Array.from({ length: 5 }, async () => {
    const leaseId = randomUUID();
    const started = await acquire(executionKey, leaseId);
    if (!started) return "busy";
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const quota = await consume("executions", 500);
      assert(quota?.allowed === true, "Started execution did not consume quota.");
      return "started";
    } finally {
      await release(executionKey, leaseId);
    }
  }));
  const executionCounter = requireData(await admin
    .from("usage_counters")
    .select("used")
    .eq("user_id", userId)
    .eq("metric", "executions")
    .eq("period_started_at", period)
    .single(), "read execution counter");
  results.executionConcurrency = {
    started: executionAttempts.filter((value) => value === "started").length,
    busy: executionAttempts.filter((value) => value === "busy").length,
    charged: executionCounter.used,
  };
  assert(results.executionConcurrency.started === 1 && results.executionConcurrency.busy === 4, "Concurrency limit was bypassed.");
  assert(executionCounter.used === 1, "Execution quota was not charged exactly once.");

  requireData(await admin.from("usage_counters").upsert({
    user_id: userId,
    metric: "quota-race",
    period_started_at: period,
    used: 499,
    updated_at: new Date().toISOString(),
  }), "seed quota race");
  const quotaRace = await Promise.all(Array.from({ length: 10 }, () => consume("quota-race", 500)));
  const quotaCounter = requireData(await admin
    .from("usage_counters")
    .select("used")
    .eq("user_id", userId)
    .eq("metric", "quota-race")
    .eq("period_started_at", period)
    .single(), "read quota race counter");
  results.quotaBoundary = {
    allowed: quotaRace.filter((row) => row?.allowed).length,
    rejected: quotaRace.filter((row) => !row?.allowed).length,
    finalUsed: quotaCounter.used,
  };
  assert(results.quotaBoundary.allowed === 1 && results.quotaBoundary.rejected === 9, "Quota race admitted an invalid number of requests.");
  assert(quotaCounter.used === 500, "Quota counter exceeded or missed its boundary.");

  requireData(await admin.from("usage_counters").upsert({
    user_id: userId,
    metric: "lease-failure",
    period_started_at: period,
    used: 1,
    updated_at: new Date().toISOString(),
  }), "seed failed-quota case");
  const failureKey = `${leasePrefix}:failure`;
  const failureLease = randomUUID();
  assert(await acquire(failureKey, failureLease), "Could not acquire failure-path lease.");
  try {
    const rejected = await consume("lease-failure", 1);
    assert(rejected?.allowed === false, "Failure-path quota should have rejected.");
  } finally {
    await release(failureKey, failureLease);
  }
  const { count: failureLeaseCount, error: failureCountError } = await admin
    .from("security_concurrency_leases")
    .select("lease_id", { count: "exact", head: true })
    .eq("key_hash", failureKey);
  if (failureCountError) throw new Error(`count failure leases: ${failureCountError.message}`);
  results.failedQuotaLeaseRelease = { activeLeases: failureLeaseCount };
  assert(failureLeaseCount === 0, "Quota failure leaked a concurrency lease.");

  const ttlKey = `${leasePrefix}:ttl`;
  const firstTtlLease = randomUUID();
  const secondTtlLease = randomUUID();
  const firstStarted = await acquire(ttlKey, firstTtlLease, 1, 1);
  const immediateSecond = await acquire(ttlKey, secondTtlLease, 1, 1);
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  const recoveredSecond = await acquire(ttlKey, secondTtlLease, 1, 1);
  await release(ttlKey, secondTtlLease);
  results.ttlRecovery = { firstStarted, immediateSecond, recoveredSecond };
  assert(firstStarted === true && immediateSecond === false && recoveredSecond === true, "Expired lease did not recover safely.");

  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
} finally {
  if (userId) {
    const leaseCleanup = await admin
      .from("security_concurrency_leases")
      .delete()
      .like("key_hash", `${leasePrefix}%`);
    if (leaseCleanup.error) throw new Error(`cleanup leases: ${leaseCleanup.error.message}`);
    const userCleanup = await admin.auth.admin.deleteUser(userId);
    if (userCleanup.error) throw new Error(`cleanup disposable user: ${userCleanup.error.message}`);
  }
}
