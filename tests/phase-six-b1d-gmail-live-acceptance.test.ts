import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { GOOGLE_SCOPES } from "../lib/connectors/google/scopes";
import {
  GMAIL_LIVE_ACCEPTANCE_ENV_NAMES,
  GMAIL_LIVE_ACCEPTANCE_MARKER,
  GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES,
  hasExactGmailLiveAcceptanceScopes,
  isGmailLiveAcceptanceMailbox,
  isGmailLiveAcceptanceOperatorAuthorized,
  isGmailLiveAcceptanceOwner,
  readGmailLiveAcceptancePolicy,
  type GmailLiveAcceptanceEnvironment,
} from "../lib/operations/gmail-live-acceptance-policy";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OPERATOR_SECRET = "phase6b1d-dedicated-operator-secret-0001";

function validEnvironment(
  overrides: GmailLiveAcceptanceEnvironment = {},
): GmailLiveAcceptanceEnvironment {
  return {
    PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED: "true",
    PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET: OPERATOR_SECRET,
    PHASE6B1D_GMAIL_ACCEPTANCE_OWNER_ID: OWNER_ID,
    PHASE6B1D_GMAIL_ACCEPTANCE_ACCOUNT_EMAIL: "Acceptance.Account@example.com",
    PHASE6B1D_GMAIL_ACCEPTANCE_RECIPIENT_EMAIL: "recipient@example.com",
    PHASE6B1D_GMAIL_ACCEPTANCE_RUN_ID: RUN_ID,
    ...overrides,
  };
}

test("6B.1D-A acceptance is disabled by default", () => {
  assert.deepEqual(readGmailLiveAcceptancePolicy({}), { status: "disabled", config: null });
});

test("6B.1D-B only exact lowercase true enables the policy", () => {
  for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes"]) {
    assert.equal(
      readGmailLiveAcceptancePolicy(validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED: value })).status,
      "disabled",
    );
  }
  assert.equal(readGmailLiveAcceptancePolicy(validEnvironment()).status, "enabled");
});

test("6B.1D-C incomplete enabled configuration fails closed", () => {
  for (const name of GMAIL_LIVE_ACCEPTANCE_ENV_NAMES.slice(1)) {
    const environment = validEnvironment({ [name]: "" });
    assert.equal(readGmailLiveAcceptancePolicy(environment).status, "invalid", name);
  }
});

test("6B.1D-D malformed identifiers and mailboxes fail closed", () => {
  assert.equal(readGmailLiveAcceptancePolicy(validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_OWNER_ID: "owner-a" })).status, "invalid");
  assert.equal(readGmailLiveAcceptancePolicy(validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_RUN_ID: "run-a" })).status, "invalid");
  assert.equal(readGmailLiveAcceptancePolicy(validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_ACCOUNT_EMAIL: "not-an-email" })).status, "invalid");
  assert.equal(readGmailLiveAcceptancePolicy(validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_RECIPIENT_EMAIL: "recipient" })).status, "invalid");
});

test("6B.1D-E acceptance and recipient mailboxes must be distinct after normalization", () => {
  assert.equal(
    readGmailLiveAcceptancePolicy(validEnvironment({
      PHASE6B1D_GMAIL_ACCEPTANCE_RECIPIENT_EMAIL: " acceptance.account@EXAMPLE.com ",
    })).status,
    "invalid",
  );
  const policy = readGmailLiveAcceptancePolicy(validEnvironment());
  assert.equal(policy.status, "enabled");
  if (policy.status === "enabled") {
    assert.equal(policy.config.accountEmail, "acceptance.account@example.com");
    assert.equal(policy.config.marker, GMAIL_LIVE_ACCEPTANCE_MARKER);
  }
});

test("6B.1D-F operator secret requires at least 32 non-whitespace characters", () => {
  assert.equal(readGmailLiveAcceptancePolicy(validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET: "x".repeat(31) })).status, "invalid");
  assert.equal(readGmailLiveAcceptancePolicy(validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET: "x".repeat(31) + " " })).status, "invalid");
});

test("6B.1D-G operator secret cannot reuse an infrastructure secret", () => {
  for (const name of [
    "CRON_SECRET",
    "SCHEDULE_DISPATCH_SECRET",
    "CONNECTOR_RUNNER_SECRET",
    "FLOWMIND_CREDENTIAL_MASTER_KEY",
    "FLOWMIND_RATE_LIMIT_SECRET",
    "SUPABASE_SECRET_KEY",
    "TURNSTILE_SECRET_KEY",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  ]) {
    assert.equal(readGmailLiveAcceptancePolicy(validEnvironment({ [name]: OPERATOR_SECRET })).status, "invalid", name);
  }
});

test("6B.1D-H owner, mailbox, and constant-time bearer authorization fail closed", () => {
  const environment = validEnvironment();
  assert.equal(isGmailLiveAcceptanceOwner(OWNER_ID, environment), true);
  assert.equal(isGmailLiveAcceptanceOwner("33333333-3333-4333-8333-333333333333", environment), false);
  assert.equal(isGmailLiveAcceptanceMailbox("ACCEPTANCE.ACCOUNT@EXAMPLE.COM", environment), true);
  assert.equal(isGmailLiveAcceptanceMailbox("recipient@example.com", environment), false);
  assert.equal(isGmailLiveAcceptanceOperatorAuthorized(`Bearer ${OPERATOR_SECRET}`, environment), true);
  for (const authorization of [null, "", OPERATOR_SECRET, "Basic anything", "Bearer", "Bearer wrong", `Bearer ${OPERATOR_SECRET} extra`]) {
    assert.equal(isGmailLiveAcceptanceOperatorAuthorized(authorization, environment), false);
  }
});

test("6B.1D-H2 returned policy objects never expose the operator secret", () => {
  const environment = validEnvironment();
  const policy = readGmailLiveAcceptancePolicy(environment);
  assert.equal(policy.status, "enabled");
  if (policy.status === "enabled") {
    assert.equal(Object.hasOwn(policy.config, "operatorSecret"), false);
    assert.equal("operatorSecret" in policy.config, false);
  }
  assert.equal(JSON.stringify(policy).includes(OPERATOR_SECRET), false);
  assert.equal(isGmailLiveAcceptanceOperatorAuthorized(`Bearer ${OPERATOR_SECRET}`, environment), true);
  assert.equal(isGmailLiveAcceptanceOperatorAuthorized(`Bearer ${OPERATOR_SECRET}-wrong`, environment), false);
  assert.equal(
    readGmailLiveAcceptancePolicy(validEnvironment({ CRON_SECRET: OPERATOR_SECRET })).status,
    "invalid",
  );
  assert.equal(
    readGmailLiveAcceptancePolicy(validEnvironment({
      PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET: "too-short",
    })).status,
    "invalid",
  );
});

test("6B.1D-I acceptance configuration has no NEXT_PUBLIC surface", async () => {
  assert.equal(GMAIL_LIVE_ACCEPTANCE_ENV_NAMES.some((name) => name.startsWith("NEXT_PUBLIC_")), false);
  const inventory = await readFile(".env.example", "utf8");
  assert.doesNotMatch(inventory, /NEXT_PUBLIC_PHASE6B1D_GMAIL_ACCEPTANCE_/);
});

test("6B.1D-J/K OAuth scope policy is exact and rejects every broader Google scope", () => {
  assert.deepEqual(GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES, [
    "openid",
    "email",
    GOOGLE_SCOPES.gmailReadonly,
    GOOGLE_SCOPES.gmailSend,
  ]);
  assert.equal(hasExactGmailLiveAcceptanceScopes([...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES]), true);
  assert.equal(hasExactGmailLiveAcceptanceScopes(GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES.slice(0, -1)), false);
  assert.equal(hasExactGmailLiveAcceptanceScopes([...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES, GOOGLE_SCOPES.gmailSend]), false);
  for (const forbidden of [
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/unknown",
  ]) {
    assert.equal(hasExactGmailLiveAcceptanceScopes([...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES, forbidden]), false, forbidden);
  }
});

test("6B.1D-L/M Gmail capabilities remain reviewed and unavailable to customers", () => {
  for (const id of [
    "gmail_new_email",
    "gmail_new_email_matching_search",
    "gmail_send_email",
    "gmail_reply_to_email",
  ] as const) {
    const capability = CAPABILITY_REGISTRY[id];
    assert.ok(capability, id);
    assert.equal(capability.maturity, "REVIEWED", id);
    assert.equal(capability.supported, false, id);
    assert.equal(capability.availableInTest, false, id);
    assert.equal(capability.availableInProduction, false, id);
    assert.deepEqual(capability.onboarding, { available: false, method: "oauth2" }, id);
    assert.equal(capability.plannerVisible, false, id);
    assert.equal(capability.builderVisible, false, id);
    assert.equal(capability.connectionVisible, false, id);
    assert.equal(capability.customerVisible, false, id);
  }
});

test("6B.1D-N/O connections remain early access and OAuth still enforces onboarding", async () => {
  const [connections, oauth] = await Promise.all([
    readFile("components/connections-list.tsx", "utf8"),
    readFile("lib/connectors/oauth.ts", "utf8"),
  ]);
  assert.match(connections, /<h2[^>]*>Google apps<\/h2>/);
  assert.match(connections, />Early Access<\/span>/);
  assert.doesNotMatch(connections, /Connect Gmail/);
  assert.match(oauth, /createOAuthAuthorization/);
  assert.match(oauth, /!getConnectorOnboarding\(input\.connectorId\)\?\.available/);
});

test("6B.1D-P Gate 1 policy has no credential reads, body reads, network calls, or secret logging", async () => {
  const policy = await readFile("lib/operations/gmail-live-acceptance-policy.ts", "utf8");
  assert.doesNotMatch(policy, /console\.(?:log|error|warn|info)/);
  assert.doesNotMatch(policy, /(?:request|response)\.(?:json|text|arrayBuffer|formData)\s*\(/i);
  assert.doesNotMatch(policy, /searchParams|\.body\b/);
  assert.doesNotMatch(policy, /(?:fetch|googleApiFetch)\s*\(/);
  assert.doesNotMatch(policy, /credential-(?:vault|crypto)|decryptCredential|readConnectionCredential/);
  assert.doesNotMatch(policy, /access_token|refresh_token/);
});

test("6B.1D environment validator keeps disabled config optional and rejects malformed enabled config", async () => {
  const example = await readFile(".env.example", "utf8");
  const directory = await mkdtemp(join(tmpdir(), "phase6b1d-env-"));
  const environmentFile = join(directory, ".env.acceptance");
  try {
    await writeFile(environmentFile, example, "utf8");
    const disabled = spawnSync(process.execPath, ["scripts/validate-env.mjs", environmentFile], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(disabled.status, 0, disabled.stderr);

    await writeFile(
      environmentFile,
      example.replace("PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED=false", "PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED=true"),
      "utf8",
    );
    const invalid = spawnSync(process.execPath, ["scripts/validate-env.mjs", environmentFile], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(invalid.status, 0);
    assert.doesNotMatch(`${invalid.stdout}${invalid.stderr}`, new RegExp(OPERATOR_SECRET));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Future Gate invariant: the callback rejects every returned scope outside the exact
// allowlist, including broader scopes retained through Google's incremental grants.
// Future Gate invariant: an accepted connection receives a durable, server-owned
// acceptanceRunId marker before it can ever qualify for cleanup.
// Future Gate invariant: cleanup matches the exact owner and run marker only.
// Future Gate invariant: a pre-existing ordinary Google connection is never silently adopted.
// Future Gate invariant: exact Pub/Sub replay stays deterministic in automation, and
// live acceptance must never weaken acknowledgement semantics.
