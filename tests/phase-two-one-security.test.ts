import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decryptCredential,
  encryptCredential,
} from "../lib/security/credential-crypto";

const root = process.cwd();
const source = (path: string) => readFileSync(`${root}/${path}`, "utf8");
const authAction = source("app/actions/auth.ts");
const executionAction = source("app/actions/execute.ts");
const publicAction = source("app/f/[projectId]/actions.ts");
const workflowAction = source("app/actions/workflow.ts");
const capabilityRegistry = source("lib/capability-registry.ts");
const limitsSource = source("lib/security/limits.ts");
const readme = source("README.md");
const migration = source(
  "supabase/migrations/20260811000100_phase21_atomic_workflow_creation.sql",
);
const turnstileMigration = source(
  "supabase/migrations/20260811000200_phase21_public_form_turnstile.sql",
);
const contentionCheck = source("scripts/phase2-contention-check.mjs");
const adminClient = source("lib/supabase/admin.ts");
const publicConfig = source("lib/supabase/config.ts");
const anonymousRlsCheck = source("scripts/verify-anonymous-rls.mjs");

const workflowId = "00000000-0000-4000-8000-000000000001";
const context = {
  userId: "user-a",
  workflowId,
  connectorId: "example",
  credentialKey: "api_key",
};

test("2.1-1. all public password auth flows forward a CAPTCHA token to Supabase", () => {
  assert.match(
    authAction,
    /signInWithPassword\([\s\S]*options: \{ captchaToken: parsed\.data\.captchaToken \}/,
  );
  assert.match(
    authAction,
    /resetPasswordForEmail\([\s\S]*captchaToken: parsed\.data\.captchaToken/,
  );
  assert.match(
    authAction,
    /signUp\([\s\S]*captchaToken: parsed\.data\.captchaToken/,
  );
  assert.match(authAction, /authoritative boundary because direct Auth endpoints bypass this action/);
});

test("2.1-2. the app limiter is documented only as defense in depth", () => {
  assert.match(readme, /Supabase Auth CAPTCHA is the authoritative control/i);
  assert.match(readme, /does not protect requests sent directly to Supabase/i);
  assert.match(limitsSource, /recovery: \{ limit: 5, windowSeconds: 3_600 \}/);
});

test("2.1-3. authenticated execution acquires workflow capacity before consuming execution quota", () => {
  const lease = executionAction.indexOf('"workflow-execution"');
  const quota = executionAction.indexOf(
    'await enforceUsageQuota(auth.user.id, "executions")',
  );
  assert.ok(lease >= 0 && quota > lease);
});

test("2.1-4. public execution acquires workflow capacity before consuming execution quota", () => {
  const lease = publicAction.indexOf('"workflow-execution"');
  const quota = publicAction.indexOf(
    'await enforceUsageQuota(publicWorkflow.ownerId, "executions")',
  );
  assert.ok(lease >= 0 && quota > lease);
});

test("2.1-5. quota rejection and thrown work always release a concurrency lease", () => {
  assert.match(
    limitsSource,
    /export async function withConcurrencyLease[\s\S]*try \{[\s\S]*return await work\(\);[\s\S]*\} finally \{[\s\S]*release_security_concurrency/,
  );
});

test("2.1-6. AI output usage uses provider metadata with a deterministic fallback", () => {
  for (const action of [executionAction, publicAction]) {
    assert.match(
      action,
      /result\.metadata\.outputTokens \?\? Math\.max\(1, Math\.ceil\(result\.text\.length \/ 4\)\)/,
    );
  }
});

test("2.1-7. workflow creation is one locked database transaction", () => {
  assert.match(migration, /create or replace function public\.create_workflow_with_quota/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /select count\(\*\)[\s\S]*insert into public\.workflows/i);
  assert.match(
    migration,
    /revoke all on function public\.create_workflow_with_quota[\s\S]*from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.create_workflow_with_quota[\s\S]*to service_role/i,
  );
  assert.match(workflowAction, /admin\.rpc\("create_versioned_workflow_with_quota"/);
  assert.doesNotMatch(workflowAction, /WORKFLOW_LIMIT[\s\S]*select\("id", \{ count: "exact", head: true \}\)/);
});

test("2.1-8. a canonical padded 32-byte master key is accepted", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptCredential("disposable-secret", context, key);
  assert.equal(decryptCredential(encrypted, context, key), "disposable-secret");
});

test("2.1-9. every malformed master-key representation fails closed", async (t) => {
  const canonical = Buffer.alloc(32, 0).toString("base64");
  const malformed: Record<string, string> = {
    "too short": Buffer.alloc(16, 1).toString("base64"),
    "too long": Buffer.alloc(64, 1).toString("base64"),
    "trailing invalid characters": `${canonical}!!!!`,
    "leading invalid characters": `!!!!${canonical}`,
    "embedded whitespace": `${canonical.slice(0, 20)} \n${canonical.slice(20)}`,
    "incorrect padding": canonical.slice(0, -1),
    "extra padding": `${canonical}=`,
    "truncated Base64": canonical.slice(0, -2),
    "noncanonical alternate encoding": `${canonical.slice(0, -2)}B=`,
    "valid Base64 decoding to 31 bytes": Buffer.alloc(31, 2).toString("base64"),
    "valid Base64 decoding to 33 bytes": Buffer.alloc(33, 2).toString("base64"),
  };

  for (const [name, key] of Object.entries(malformed)) {
    await t.test(name, () => {
      assert.throws(() => encryptCredential("secret", context, key));
    });
  }
});

test("2.1-10. tag corruption and authenticated-context mismatch still fail", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const encrypted = encryptCredential("disposable-secret", context, key);
  assert.throws(() =>
    decryptCredential(
      { ...encrypted, authTag: Buffer.alloc(16).toString("base64") },
      context,
      key,
    ),
  );
  assert.throws(() =>
    decryptCredential(
      encrypted,
      { ...context, workflowId: "00000000-0000-4000-8000-000000000002" },
      key,
    ),
  );
});

test("2.1-11. webhook authentication and ownership precede DNS validation", () => {
  const functionStart = workflowAction.indexOf("export async function saveWebhookEndpoint");
  const scoped = workflowAction.slice(functionStart);
  const auth = scoped.indexOf("await getAuthenticatedContext()");
  const owner = scoped.indexOf("loadWorkflowSnapshot(admin, request.data.workflowId, auth.user.id)");
  const capability = scoped.indexOf('resolveStepCapabilityId(step) === "webhook_post"');
  const dns = scoped.indexOf("await resolveTrustedWebhook(request.data.endpoint)");
  assert.ok(auth >= 0 && owner > auth && capability > owner && dns > capability);
});

test("2.1-12. costly public forms automatically require Turnstile", () => {
  assert.match(capabilityRegistry, /COSTLY_PUBLIC_CAPABILITIES[\s\S]*ai_text_transform[\s\S]*generate_pdf/);
  assert.match(
    workflowAction,
    /public_form_challenge_mode:[\s\S]{0,100}requiresPublicFormTurnstile/,
  );
  assert.match(publicAction, /challengeMode === "turnstile"[\s\S]*verifyTurnstile/);
  assert.match(
    turnstileMigration,
    /public_form_challenge_mode = case[\s\S]*then 'turnstile'/,
  );
  assert.match(readme, /automatically enables\s+Cloudflare Turnstile/i);
});

test("2.1-13. production contention check covers atomic boundaries and cleans fixtures", () => {
  assert.match(contentionCheck, /Promise\.all\(Array\.from\(\{ length: 10 \}/);
  assert.match(contentionCheck, /started === 1 && results\.executionConcurrency\.busy === 4/);
  assert.match(contentionCheck, /quotaCounter\.used === 500/);
  assert.match(contentionCheck, /recoveredSecond === true/);
  assert.match(contentionCheck, /finally[\s\S]*deleteUser\(userId\)/);
});

test("2.1-14. privileged Supabase access uses only the modern server secret", () => {
  assert.match(adminClient, /process\.env\.SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(adminClient, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(adminClient, /import "server-only"/);
  assert.match(contentionCheck, /env\.SUPABASE_SECRET_KEY/);
});

test("2.1-15. browser and anonymous checks require only the modern publishable key", () => {
  assert.match(publicConfig, /process\.env\.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(publicConfig, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  assert.match(anonymousRlsCheck, /environment\.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.doesNotMatch(anonymousRlsCheck, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
});
