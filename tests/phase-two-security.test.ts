import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decryptCredential,
  encryptCredential,
} from "../lib/security/credential-crypto";
import {
  isAcknowledgedWebhookStatus,
  isBlockedOutboundAddress,
  parseTrustedWebhookUrl,
} from "../lib/security/outbound-webhook";
import { isSensitiveFieldName, redactForLog } from "../lib/security/redaction";
import type { CompiledWorkflow } from "../lib/schemas/workflow";
import { executeWorkflowSteps } from "../lib/workflow-execution";

const root = process.cwd();
const source = (path: string) => readFileSync(`${root}/${path}`, "utf8");
const phaseTwoMigration = source(
  "supabase/migrations/20260810000100_phase2_security_boundaries.sql",
);
const ownershipMigration = source(
  "supabase/migrations/20260807000100_workflow_ownership_rls.sql",
);
const executionAction = source("app/actions/execute.ts");
const publicAction = source("app/f/[projectId]/actions.ts");
const workflowAction = source("app/actions/workflow.ts");
const workspaceSource = source("components/automation-workspace.tsx");
const credentialAction = source("app/actions/credentials.ts");
const documentAction = source("app/actions/documents.ts");
const outboundSource = source("lib/security/outbound-webhook.ts");

const workflowId = "00000000-0000-4000-8000-000000000001";
function steps(items: CompiledWorkflow["steps"]): CompiledWorkflow["steps"] {
  return items;
}

test("1. anonymous execution insert privilege and policy are removed", () => {
  assert.match(phaseTwoMigration, /drop policy if exists "Public forms can create execution logs"/i);
  assert.match(phaseTwoMigration, /revoke all on table public\.workflow_executions from anon, authenticated/i);
  assert.doesNotMatch(phaseTwoMigration, /grant insert[^;]*workflow_executions[^;]*anon/i);
});

test("2. anonymous execution update and delete remain denied", () => {
  assert.match(phaseTwoMigration, /drop policy if exists "Users can update their own execution logs"/i);
  assert.match(phaseTwoMigration, /drop policy if exists "Users can delete their own execution logs"/i);
  assert.doesNotMatch(phaseTwoMigration, /grant (?:update|delete)[^;]*workflow_executions/i);
});

test("3. execution SELECT is owner-scoped for account isolation", () => {
  const executionMigration = source(
    "supabase/migrations/20260807000200_hosted_forms_and_executions.sql",
  );
  assert.match(executionMigration, /workflow\.user_id = \(select auth\.uid\(\)\)/i);
  assert.match(phaseTwoMigration, /grant select on table public\.workflow_executions to authenticated/i);
});

test("4. workflow read and mutations are owner-scoped", () => {
  assert.match(ownershipMigration, /for select[\s\S]*auth\.uid\(\)\) = user_id/i);
  assert.match(ownershipMigration, /for update[\s\S]*with check \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(ownershipMigration, /for delete[\s\S]*auth\.uid\(\)\) = user_id/i);
});

test("5. a runtime form URL cannot change the trusted webhook destination", async () => {
  let calledEndpoint = "";
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "Trusted webhook",
    steps: steps([
      {
        id: "destination",
        type: "webhook_post",
        capabilityId: "webhook_post",
        title: "Webhook",
        description: "Test delivery",
        config: { endpoint: "https://1.1.1.1/trusted", method: "POST" },
      },
    ]),
    inputValues: {
      destination_url: "https://8.8.8.8/attacker",
      webhook: "https://8.8.4.4/attacker",
    },
    mode: "test",
    executeWebhook: async (endpoint) => {
      calledEndpoint = endpoint;
      return { status: 204 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calledEndpoint, "https://1.1.1.1/trusted");
});

test("6. runtime URL input cannot create a webhook when trusted config is absent", async () => {
  let calls = 0;
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "No relay",
    steps: steps([{ id: "destination", type: "webhook_post", capabilityId: "webhook_post", title: "Webhook", description: "Test" }]),
    inputValues: { destination_url: "https://1.1.1.1/attacker" },
    mode: "test",
    executeWebhook: async () => {
      calls += 1;
      return { status: 200 };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.delivered, false);
  assert.equal(result.outputData.steps[0]?.status, "skipped");
});

test("7. localhost and cloud metadata destinations are blocked", () => {
  for (const endpoint of [
    "https://localhost/test",
    "https://127.0.0.1/test",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    assert.throws(() => parseTrustedWebhookUrl(endpoint));
  }
});

test("8. private and reserved IPv4 ranges are blocked", () => {
  for (const address of [
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "203.0.113.1",
  ]) {
    assert.equal(isBlockedOutboundAddress(address), true, address);
  }
  assert.equal(isBlockedOutboundAddress("1.1.1.1"), false);
});

test("9. private, loopback, mapped, and documentation IPv6 are blocked", () => {
  for (const address of ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
    assert.equal(isBlockedOutboundAddress(address), true, address);
  }
});

test("10. redirects are not acknowledged or followed", () => {
  assert.equal(isAcknowledgedWebhookStatus(302), false);
  assert.equal(isAcknowledgedWebhookStatus(307), false);
  assert.match(outboundSource, /if \(!isAcknowledgedWebhookStatus\(status\)\)/);
  assert.doesNotMatch(outboundSource, /followRedirect|redirect:\s*["']follow/i);
});

test("11. DNS results are bounded, all checked, and a validated address is pinned", () => {
  assert.match(outboundSource, /DNS_TIMEOUT_MS = 2_000/);
  assert.match(outboundSource, /addresses\.some\(\(\{ address \}\) => isBlockedOutboundAddress\(address\)\)/);
  assert.match(outboundSource, /lookup: \(_hostname, _options, callback\) => callback\(null, address, family\)/);
});

test("12. credentials are excluded from localStorage persistence and legacy keys are cleaned", () => {
  assert.match(workspaceSource, /input\.type === "secret"/);
  assert.match(workspaceSource, /!isSensitiveFieldName\(key\)/);
  assert.equal(isSensitiveFieldName("step_2-api_key"), true);
  assert.equal(isSensitiveFieldName("oauth_refresh_token"), true);
});

test("13. credential client responses contain metadata, never plaintext", () => {
  assert.match(credentialAction, /CredentialMetadata/);
  assert.doesNotMatch(
    credentialAction.match(/return \{ ok: true, credential \};/)?.[0] ?? "",
    /secret|ciphertext|authTag/i,
  );
  assert.match(credentialAction, /secret: z\.string\(\)\.min\(1\)\.max\(10_000\)/);
});

test("14. credential AES-GCM round trip binds ciphertext to owner context", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const context = { userId: "user-a", workflowId, connectorId: "example", credentialKey: "api_key" };
  const encrypted = encryptCredential("disposable-secret", context, key);
  assert.notEqual(encrypted.ciphertext, "disposable-secret");
  assert.equal(encrypted.algorithm, "aes-256-gcm");
  assert.equal(encrypted.encryptionVersion, 1);
  assert.equal(decryptCredential(encrypted, context, key), "disposable-secret");
  assert.throws(() => decryptCredential(encrypted, { ...context, userId: "user-b" }, key));
});

test("15. credential tampering fails closed", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const context = { userId: "user-a", workflowId, connectorId: "example", credentialKey: "api_key" };
  const encrypted = encryptCredential("disposable-secret", context, key);
  assert.throws(() => decryptCredential({ ...encrypted, authTag: Buffer.alloc(16).toString("base64") }, context, key));
});

test("16. logging redacts known credential fields and authorization values", () => {
  const redacted = redactForLog({ authorization: "Bearer abc.def.ghi", api_key: "secret", safe: "ok" }) as Record<string, unknown>;
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.api_key, "[REDACTED]");
  assert.equal(redacted.safe, "ok");
});

test("17. new workflows are unpublished by database and server write defaults", () => {
  assert.match(phaseTwoMigration, /alter column public_form_enabled set default false/i);
  assert.match(workflowAction, /public_form_enabled: false/);
  assert.match(workflowAction, /published_at: null/);
});

test("18. explicit owner publish enables only production-valid hosted forms", () => {
  assert.match(workflowAction, /export async function setWorkflowPublication/);
  assert.match(workflowAction, /assessWorkflowCapabilities\(workflow\.data\.steps, "production"\)/);
  assert.match(workflowAction, /public_form_enabled: publish/);
});

test("19. unpublish revokes anonymous form lookup immediately", () => {
  assert.match(phaseTwoMigration, /where workflow\.id = p_workflow_id[\s\S]*workflow\.public_form_enabled/i);
  assert.match(workflowAction, /published_at: publish \? new Date\(\)\.toISOString\(\) : null/);
});

test("20. generated documents use a private bounded PDF-only bucket", () => {
  assert.match(phaseTwoMigration, /set public = false/i);
  assert.match(phaseTwoMigration, /file_size_limit = 5242880/i);
  assert.match(phaseTwoMigration, /allowed_mime_types = array\['application\/pdf'\]/i);
  assert.doesNotMatch(source("lib/document-storage.ts"), /getPublicUrl/);
});

test("21. signed document links are owner-scoped", () => {
  assert.match(documentAction, /\.eq\("user_id", auth\.user\.id\)/);
  assert.match(documentAction, /generated_document_records/);
  assert.match(documentAction, /createSignedUrl/);
});

test("22. signed document links expire after fifteen minutes", () => {
  assert.match(documentAction, /DOCUMENT_SIGNED_URL_TTL_SECONDS = 15 \* 60/);
  assert.match(documentAction, /expiresInSeconds: DOCUMENT_SIGNED_URL_TTL_SECONDS/);
});

test("23. public forms enforce IP, workflow, duplicate, quota, and execution concurrency gates", () => {
  for (const marker of [
    '"public-form-ip"',
    '"public-form-workflow"',
    '"public-form-duplicate"',
    '"public_form_submissions"',
    '"workflow-execution"',
  ]) assert.match(publicAction, new RegExp(marker));
});

test("24. authenticated AI and test execution enforce durable gates", () => {
  assert.match(executionAction, /enforceRateLimit\([\s\S]*"test-execution"/);
  assert.match(executionAction, /enforceRateLimit\("ai-execution"/);
  assert.match(executionAction, /enforceUsageQuota\(auth\.user\.id, "ai_generations"\)/);
  assert.match(executionAction, /withConcurrencyLease\([\s\S]*"user-execution"/);
});

test("25. durable rate limiting uses an atomic service-role-only database function", () => {
  assert.match(phaseTwoMigration, /create or replace function public\.consume_security_rate_limit/i);
  assert.match(phaseTwoMigration, /pg_advisory_xact_lock/i);
  assert.match(phaseTwoMigration, /grant execute on function public\.consume_security_rate_limit[^;]*to service_role/i);
});

test("26. usage quotas are atomic and reject an amount beyond the configured limit", () => {
  assert.match(phaseTwoMigration, /create or replace function public\.consume_usage_quota/i);
  assert.match(phaseTwoMigration, /if current_used \+ p_amount > p_limit then/i);
  assert.match(phaseTwoMigration, /return query select false/i);
});

test("27. concurrency leases are durable, bounded, and expire", () => {
  assert.match(phaseTwoMigration, /create table if not exists public\.security_concurrency_leases/i);
  assert.match(phaseTwoMigration, /if active_count >= p_limit then return false/i);
  assert.match(phaseTwoMigration, /expires_at <= clock_timestamp\(\)/i);
});

test("28. trusted execution records are written through the admin client", () => {
  assert.match(executionAction, /const admin = createAdminClient\(\)/);
  assert.match(executionAction, /await admin[\s\S]*\.from\("workflow_executions"\)/);
  assert.match(publicAction, /publicWorkflow\.admin[\s\S]*\.from\("workflow_executions"\)/);
});

test("29. public form lifecycle remains POST-Redirect-GET", () => {
  assert.match(publicAction, /redirect\(resultPath\(projectId, outcome\)\)/);
  assert.match(publicAction, /Promise<never>/);
  assert.doesNotMatch(publicAction, /return\s+\{\s*status:\s*"success"/);
});

test("30. security controls fail closed when their database backend fails", () => {
  const limitsSource = source("lib/security/limits.ts");
  assert.match(limitsSource, /throw new SecurityGateError\("This request cannot be accepted safely right now\."/);
  assert.match(limitsSource, /if \(error \|\| !data\?\.\[0\]\) throw new Error\("rate backend failed"\)/);
  assert.match(limitsSource, /if \(error\) throw new SecurityGateError/);
});

test("31. browser workflow mutations cannot bypass publication or quotas", () => {
  assert.match(
    phaseTwoMigration,
    /revoke insert, update, delete on table public\.workflows from authenticated/i,
  );
  assert.match(
    phaseTwoMigration,
    /grant select on table public\.workflows to authenticated/i,
  );
  assert.match(workflowAction, /const admin = createAdminClient\(\)/);
});
