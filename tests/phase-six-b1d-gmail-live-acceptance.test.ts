import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { resolveGoogleConnectionForFinalization } from "../lib/connectors/google/oauth-finalization-core";
import { exchangeGoogleAuthorizationCode } from "../lib/connectors/google/oauth-provider";
import type { OAuthTokenSet } from "../lib/connectors/oauth-exchange";
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
import {
  GMAIL_LIVE_ACCEPTANCE_CALLBACK_PATH,
  GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID,
  finalizeGmailLiveAcceptanceConnection,
  getGmailLiveAcceptanceCallbackContext,
  hasValidGmailLiveAcceptanceTokens,
  startGmailLiveAcceptanceOAuth,
  type ExistingAcceptanceGoogleConnection,
  type GmailLiveAcceptanceCallbackContext,
  type GmailLiveAcceptanceOAuthState,
} from "../lib/operations/gmail-live-acceptance-oauth";

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

function acceptanceState(
  overrides: Partial<GmailLiveAcceptanceOAuthState> = {},
): GmailLiveAcceptanceOAuthState {
  return {
    userId: OWNER_ID,
    connectorId: GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID,
    scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES],
    operationKey: GMAIL_LIVE_ACCEPTANCE_MARKER,
    connectionId: null,
    ...overrides,
  };
}

function acceptanceContext(): GmailLiveAcceptanceCallbackContext {
  const context = getGmailLiveAcceptanceCallbackContext({
    connectorId: GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID,
    userId: OWNER_ID,
    oauth: acceptanceState(),
    environment: validEnvironment(),
  });
  assert.ok(context);
  return context;
}

function acceptanceTokens(overrides: Partial<OAuthTokenSet> = {}): OAuthTokenSet {
  return {
    accessToken: "acceptance-access-token",
    refreshToken: "acceptance-refresh-token",
    expiresAt: "2030-01-01T00:00:00.000Z",
    scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES],
    scopesConfirmedByProvider: true,
    externalAccountId: "google-account-acceptance",
    externalAccountLabel: "acceptance.account@example.com",
    ...overrides,
  };
}

function existingGoogleConnection(
  safeMetadata: ExistingAcceptanceGoogleConnection["safe_metadata"],
  overrides: Partial<ExistingAcceptanceGoogleConnection> = {},
): ExistingAcceptanceGoogleConnection {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: OWNER_ID,
    connector_id: "google",
    provider_family: "google",
    external_account_id: "google-account-acceptance",
    safe_metadata: safeMetadata,
    ...overrides,
  };
}

async function exchangeMockedGoogleAuthorizationCode(scope: unknown, includeScope = true) {
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-google-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-google-client-secret";
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: "mock-google-access-token",
        refresh_token: "mock-google-refresh-token",
        expires_in: 3600,
        ...(includeScope ? { scope } : {}),
      });
    }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
      return Response.json({
        sub: "google-account-acceptance",
        email: "acceptance.account@example.com",
        email_verified: true,
      });
    }
    throw new Error(`Unexpected mocked Google request: ${url}`);
  };
  try {
    return await exchangeGoogleAuthorizationCode({
      code: "mock-authorization-code",
      verifier: "mock-pkce-verifier",
      redirectUri: "https://www.crazy-loops.com/api/connectors/oauth/google_gmail/callback",
      requestedScopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES],
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = originalClientSecret;
  }
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

test("6B.1D-L/M Gmail capabilities are customer-visible only through reviewed operations", () => {
  for (const id of [
    "gmail_new_email",
    "gmail_new_email_matching_search",
    "gmail_send_email",
    "gmail_reply_to_email",
  ] as const) {
    const capability = CAPABILITY_REGISTRY[id];
    assert.ok(capability, id);
    assert.equal(capability.maturity, "AVAILABLE", id);
    assert.equal(capability.supported, true, id);
    assert.equal(capability.availableInTest, true, id);
    assert.equal(capability.availableInProduction, true, id);
    assert.deepEqual(capability.onboarding, { available: true, method: "oauth2" }, id);
    assert.equal(capability.plannerVisible, true, id);
    assert.equal(capability.builderVisible, true, id);
    assert.equal(capability.connectionVisible, true, id);
    assert.equal(capability.customerVisible, true, id);
  }
});

test("6B.1D-N/O connections offer Gmail through OAuth onboarding", async () => {
  const [connections, oauth] = await Promise.all([
    readFile("components/connections-list.tsx", "utf8"),
    readFile("lib/connectors/oauth.ts", "utf8"),
  ]);
  assert.match(connections, /Connect Gmail/);
  assert.match(connections, /google_gmail/);
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

test("6B.1D-2A-01 private OAuth start rejects every unauthorized policy/user before state creation", async () => {
  let stateCreations = 0;
  const dependencies = {
    createAuthorization: async () => {
      stateCreations += 1;
      return { state: "state", codeChallenge: "challenge", scopes: [], returnPath: "/connections" };
    },
    buildAuthorizationUrl: () => new URL("https://accounts.google.com/o/oauth2/v2/auth"),
    getSiteOrigin: () => "https://www.crazy-loops.com",
  };
  const rejected = [
    { userId: OWNER_ID, environment: {} },
    {
      userId: OWNER_ID,
      environment: validEnvironment({ PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET: "short" }),
    },
    { userId: null, environment: validEnvironment() },
    { userId: "33333333-3333-4333-8333-333333333333", environment: validEnvironment() },
  ];
  for (const item of rejected) {
    await assert.rejects(
      startGmailLiveAcceptanceOAuth({
        userId: item.userId,
        requestOrigin: "https://attacker.invalid",
        environment: item.environment,
        dependencies,
      }),
      /unavailable/,
    );
  }
  assert.equal(stateCreations, 0);
});

test("6B.1D-2A-02 accepted start is fixed to Gmail, exact scopes, marker-owned state, and canonical callback", async () => {
  let createInput: Record<string, unknown> | null = null;
  let authorizationInput: Record<string, unknown> | null = null;
  const result = await startGmailLiveAcceptanceOAuth({
    userId: OWNER_ID,
    requestOrigin: "https://untrusted-origin.invalid",
    environment: validEnvironment(),
    dependencies: {
      createAuthorization: async (input) => {
        createInput = input;
        return {
          state: "opaque-state",
          codeChallenge: "opaque-challenge",
          scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES],
          returnPath: "/connections",
        };
      },
      buildAuthorizationUrl: (input) => {
        authorizationInput = input;
        return new URL("https://accounts.google.com/o/oauth2/v2/auth?safe=1");
      },
      getSiteOrigin: () => "https://www.crazy-loops.com",
    },
  });
  const capturedCreateInput = createInput as Record<string, unknown> | null;
  const capturedAuthorizationInput = authorizationInput as Record<string, unknown> | null;
  assert.deepEqual(Object.keys(capturedCreateInput ?? {}).sort(), ["environment", "userId"]);
  assert.equal(capturedCreateInput?.userId, OWNER_ID);
  assert.equal(capturedAuthorizationInput?.connectorId, GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID);
  assert.deepEqual(capturedAuthorizationInput?.scopes, [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES]);
  assert.equal(capturedAuthorizationInput?.selectAccount, true);
  assert.equal(
    capturedAuthorizationInput?.redirectUri,
    `https://www.crazy-loops.com${GMAIL_LIVE_ACCEPTANCE_CALLBACK_PATH}`,
  );
  assert.equal(result.authorizationUrl, "https://accounts.google.com/o/oauth2/v2/auth?safe=1");

  const oauth = await readFile("lib/connectors/oauth.ts", "utf8");
  assert.match(oauth, /createGmailLiveAcceptanceOAuthAuthorization/);
  assert.match(oauth, /connectorId: "google_gmail"/);
  assert.match(oauth, /scopes: GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES/);
  assert.match(oauth, /operationKey: GMAIL_LIVE_ACCEPTANCE_MARKER/);
  assert.match(oauth, /operation_key: input\.operationKey/);
});

test("6B.1D-2A-03 private route is authenticated, parameter-free, body-free, dynamic, and private", async () => {
  const route = await readFile("app/api/operations/gmail-live-acceptance/oauth/start/route.ts", "utf8");
  assert.match(route, /export const runtime = "nodejs"/);
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /export const revalidate = 0/);
  assert.match(route, /const auth = await getAuthenticatedContext\(\)/);
  assert.match(route, /if \(!auth\) return unavailable\(\)/);
  assert.doesNotMatch(route, /getSession\(/);
  assert.match(route, /if \(requestUrl\.search\) return unavailable\(\)/);
  assert.doesNotMatch(route, /searchParams\.get|request\.(?:json|text|formData|arrayBuffer)\s*\(/);
  assert.doesNotMatch(route, /ownerId|accountEmail|recipientEmail|operatorSecret|connectionId/);
  assert.match(route, /Cache-Control/);
  assert.match(route, /private, no-store/);
  assert.match(route, /status: 404/);
});

test("6B.1D-2A-04 shared OAuth state remains 256-bit, owner/connector-bound, expiring, and single-use", async () => {
  const oauth = await readFile("lib/connectors/oauth.ts", "utf8");
  assert.match(oauth, /OAUTH_STATE_TTL_MS = 10 \* 60 \* 1_000/);
  assert.match(oauth, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(oauth, /stateHash\(state\)/);
  assert.match(oauth, /encryptCredential\(pkce\.verifier/);
  assert.match(oauth, /user_id: input\.userId/);
  assert.match(oauth, /connector_id: input\.connectorId/);
  assert.match(oauth, /\.eq\("user_id", input\.userId\)/);
  assert.match(oauth, /\.eq\("connector_id", input\.connectorId\)/);
  assert.match(oauth, /\.is\("consumed_at", null\)/);
  assert.match(oauth, /\.gt\("expires_at", new Date\(\)\.toISOString\(\)\)/);
  assert.match(oauth, /update\(\{ consumed_at: consumedAt \}\)/);
  assert.match(oauth, /!getConnectorOnboarding\(input\.connectorId\)\?\.available/);
  assert.doesNotMatch(oauth, /bypassOnboarding|skipAvailability|internal\s*:\s*true|force\s*:\s*true/);
});

test("6B.1D-2A-05 callback exception requires exact owner, connector, marker, scopes, and no intended connection", () => {
  assert.ok(acceptanceContext());
  const cases: Array<{ connectorId?: string; userId?: string; oauth?: GmailLiveAcceptanceOAuthState }> = [
    { connectorId: "google_sheets" },
    { userId: "33333333-3333-4333-8333-333333333333" },
    { oauth: acceptanceState({ userId: "33333333-3333-4333-8333-333333333333" }) },
    { oauth: acceptanceState({ connectorId: "google_sheets" }) },
    { oauth: acceptanceState({ operationKey: "gmail.send_email" }) },
    { oauth: acceptanceState({ connectionId: "33333333-3333-4333-8333-333333333333" }) },
    { oauth: acceptanceState({ scopes: GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES.slice(0, -1) }) },
    { oauth: acceptanceState({ scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES, GOOGLE_SCOPES.driveFile] }) },
  ];
  for (const item of cases) {
    assert.equal(getGmailLiveAcceptanceCallbackContext({
      connectorId: item.connectorId ?? GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID,
      userId: item.userId ?? OWNER_ID,
      oauth: item.oauth ?? acceptanceState(),
      environment: validEnvironment(),
    }), null);
  }
});

test("6B.1D-2A-06 returned Google scopes and verified mailbox must be exact", () => {
  const context = acceptanceContext();
  assert.equal(hasValidGmailLiveAcceptanceTokens(acceptanceTokens(), context), true);
  assert.equal(hasValidGmailLiveAcceptanceTokens(acceptanceTokens({ scopesConfirmedByProvider: false }), context), false);
  assert.equal(hasValidGmailLiveAcceptanceTokens(acceptanceTokens({ externalAccountLabel: "other@example.com" }), context), false);
  assert.equal(hasValidGmailLiveAcceptanceTokens(acceptanceTokens({ scopes: GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES.slice(0, -1) }), context), false);
  assert.equal(hasValidGmailLiveAcceptanceTokens(acceptanceTokens({ scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES, GOOGLE_SCOPES.gmailSend] }), context), false);
  for (const forbidden of [
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/calendar",
  ]) {
    assert.equal(hasValidGmailLiveAcceptanceTokens(acceptanceTokens({
      scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES, forbidden],
    }), context), false, forbidden);
  }
});

test("6B.1D-2A-06b real Google exchange mapping fails closed for unconfirmed or non-exact scopes", async () => {
  const context = acceptanceContext();
  const exactScope = GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES.join(" ");
  const exact = await exchangeMockedGoogleAuthorizationCode(exactScope);
  assert.equal(exact.scopesConfirmedByProvider, true);
  assert.deepEqual(exact.scopes, [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES]);
  assert.equal(hasValidGmailLiveAcceptanceTokens(exact, context), true);

  const omitted = await exchangeMockedGoogleAuthorizationCode(undefined, false);
  assert.equal(omitted.scopesConfirmedByProvider, false);
  assert.deepEqual(omitted.scopes, [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES]);
  assert.equal(hasValidGmailLiveAcceptanceTokens(omitted, context), false);

  for (const forbidden of [
    GOOGLE_SCOPES.driveFile,
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/calendar",
    "https://mail.google.com/",
  ]) {
    const broader = await exchangeMockedGoogleAuthorizationCode(`${exactScope} ${forbidden}`);
    assert.equal(broader.scopesConfirmedByProvider, true, forbidden);
    assert.equal(broader.scopes.includes(forbidden), true, forbidden);
    assert.equal(hasValidGmailLiveAcceptanceTokens(broader, context), false, forbidden);
  }

  const duplicate = await exchangeMockedGoogleAuthorizationCode(
    `${exactScope} ${GOOGLE_SCOPES.gmailSend}`,
  );
  assert.equal(duplicate.scopesConfirmedByProvider, true);
  assert.equal(
    duplicate.scopes.filter((scope) => scope === GOOGLE_SCOPES.gmailSend).length,
    2,
  );
  assert.equal(hasValidGmailLiveAcceptanceTokens(duplicate, context), false);

  await assert.rejects(
    exchangeMockedGoogleAuthorizationCode({ malicious: "scope" }),
    /split is not a function/,
  );
});

test("6B.1D-2A-07 token/mailbox mismatch revokes and never finalizes or leaks a credential", async () => {
  const context = acceptanceContext();
  let finalized = 0;
  const revoked: string[] = [];
  const dependencies = {
    findExistingConnection: async () => null,
    finalizeConnection: async () => {
      finalized += 1;
      return { id: "connection", grantedScopes: [] };
    },
    revokeToken: async (token: string) => {
      revoked.push(token);
      return true;
    },
  };
  for (const tokens of [
    acceptanceTokens({ externalAccountLabel: "wrong@example.com" }),
    acceptanceTokens({ scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES, GOOGLE_SCOPES.driveFile] }),
  ]) {
    await assert.rejects(
      finalizeGmailLiveAcceptanceConnection({ userId: OWNER_ID, tokens, context, dependencies }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /acceptance-access-token|acceptance-refresh-token|wrong@example/);
        return true;
      },
    );
  }
  assert.equal(finalized, 0);
  assert.deepEqual(revoked, ["acceptance-refresh-token", "acceptance-refresh-token"]);
});

test("6B.1D-2A-08 every pre-existing Google connection is rejected without mutation", async () => {
  const context = acceptanceContext();
  let finalized = 0;
  let revoked = 0;
  for (const connection of [
    existingGoogleConnection({ oauthConnector: "google_gmail" }),
    existingGoogleConnection({
      acceptanceMarker: GMAIL_LIVE_ACCEPTANCE_MARKER,
      acceptanceRunId: "44444444-4444-4444-8444-444444444444",
    }),
    existingGoogleConnection({
      acceptanceMarker: GMAIL_LIVE_ACCEPTANCE_MARKER,
      acceptanceRunId: RUN_ID,
    }),
  ]) {
    await assert.rejects(finalizeGmailLiveAcceptanceConnection({
      userId: OWNER_ID,
      tokens: acceptanceTokens(),
      context,
      dependencies: {
        findExistingConnection: async () => connection,
        finalizeConnection: async () => {
          finalized += 1;
          return { id: connection.id, grantedScopes: [] };
        },
        revokeToken: async () => {
          revoked += 1;
          return true;
        },
      },
    }), /could not be completed/);
  }
  assert.equal(finalized, 0);
  assert.equal(revoked, 3);
});

test("6B.1D-2A-09 clean acceptance uses new-only finalization and discards all provider metadata", async () => {
  const context = acceptanceContext();
  type FinalizeInput = {
    userId: string;
    oauthConnectorId: string;
    intendedConnectionId: string | null;
    connectionResolution: Readonly<{ mode: "new_only" }>;
    tokens: OAuthTokenSet;
  };
  let finalizedInput: FinalizeInput | null = null;
  await finalizeGmailLiveAcceptanceConnection({
    userId: OWNER_ID,
    context,
    tokens: acceptanceTokens({
      safeMetadata: {
        harmless: "hello",
        innocentKey: "authorization-code-like-value",
        another: "acceptance-access-token",
        nestedLookingValue: "prefix-acceptance-refresh-token-suffix",
        acceptanceMarker: "attacker-value",
        acceptanceRunId: "attacker-value",
      },
    }),
    dependencies: {
      findExistingConnection: async () => null,
      finalizeConnection: async (input) => {
        finalizedInput = input;
        return { id: "new-acceptance-connection", grantedScopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES] };
      },
      revokeToken: async () => true,
    },
  });
  const capturedFinalizedInput = finalizedInput as FinalizeInput | null;
  assert.equal(capturedFinalizedInput?.userId, OWNER_ID);
  assert.equal(capturedFinalizedInput?.oauthConnectorId, GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID);
  assert.equal(capturedFinalizedInput?.intendedConnectionId, null);
  assert.deepEqual(capturedFinalizedInput?.connectionResolution, { mode: "new_only" });
  assert.deepEqual(capturedFinalizedInput?.tokens.safeMetadata, {
    acceptanceMarker: GMAIL_LIVE_ACCEPTANCE_MARKER,
    acceptanceRunId: RUN_ID,
  });
  const serialized = JSON.stringify(capturedFinalizedInput?.tokens.safeMetadata);
  assert.doesNotMatch(
    serialized,
    /hello|authorization-code-like-value|acceptance-access-token|acceptance-refresh-token|attacker-value/,
  );
});

test("6B.1D-2A-09b concurrent ordinary connection conflict fails, revokes, and cannot be adopted", async () => {
  const context = acceptanceContext();
  let finalizeAttempts = 0;
  let revokedToken: string | null = null;
  await assert.rejects(finalizeGmailLiveAcceptanceConnection({
    userId: OWNER_ID,
    context,
    tokens: acceptanceTokens(),
    dependencies: {
      findExistingConnection: async () => null,
      finalizeConnection: async (input) => {
        finalizeAttempts += 1;
        assert.equal(input.intendedConnectionId, null);
        assert.deepEqual(input.connectionResolution, { mode: "new_only" });
        throw new Error("Google connection already exists");
      },
      revokeToken: async (token) => {
        revokedToken = token;
        return true;
      },
    },
  }), /could not be completed/);
  assert.equal(finalizeAttempts, 1);
  assert.equal(revokedToken, "acceptance-refresh-token");
});

test("6B.1D-2A-09c new-only shared resolution never calls existing or identity loaders", async () => {
  let exactLoads = 0;
  let identityDiscoveries = 0;
  const resolved = await resolveGoogleConnectionForFinalization(
    { mode: "new_only" },
    {
      loadExistingById: async () => {
        exactLoads += 1;
        return existingGoogleConnection({});
      },
      discoverByIdentity: async () => {
        identityDiscoveries += 1;
        return existingGoogleConnection({});
      },
    },
  );
  assert.equal(resolved, null);
  assert.equal(exactLoads, 0);
  assert.equal(identityDiscoveries, 0);
});

test("6B.1D-2A-10 callback keeps normal onboarding closed and uses owner/account-bound protection", async () => {
  const [callback, oauth, operation] = await Promise.all([
    readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8"),
    readFile("lib/connectors/oauth.ts", "utf8"),
    readFile("lib/operations/gmail-live-acceptance-oauth.ts", "utf8"),
  ]);
  assert.match(callback, /ordinaryOnboardingAvailable/);
  assert.match(callback, /mayBeGmailAcceptance = connectorId === "google_gmail"/);
  assert.match(callback, /getGmailLiveAcceptanceCallbackContext/);
  assert.match(callback, /if \(!ordinaryOnboardingAvailable && !acceptanceContext\)/);
  assert.doesNotMatch(callback, /searchParams\.get\("acceptance"\)/);
  assert.match(oauth, /\.eq\("user_id", input\.userId\)/);
  assert.match(oauth, /\.eq\("connector_id", input\.connectorId\)/);
  assert.match(operation, /\.eq\("user_id", input\.userId\)/);
  assert.match(operation, /\.eq\("connector_id", "google"\)/);
  assert.match(operation, /\.eq\("provider_family", "google"\)/);
  assert.match(operation, /\.eq\("external_account_id", input\.externalAccountId\)/);
  assert.match(callback, /oauth_callback_failed/);
  assert.doesNotMatch(callback, /console\.(?:log|error|warn)|JSON\.stringify\((?:tokens|oauth|code|state)/);
});

// Future Gate invariant: the callback rejects every returned scope outside the exact
// allowlist, including broader scopes retained through Google's incremental grants.
// Future Gate invariant: an accepted connection receives a durable, server-owned
// acceptanceRunId marker before it can ever qualify for cleanup.
// Future Gate invariant: cleanup matches the exact owner and run marker only.
// Future Gate invariant: a pre-existing ordinary Google connection is never silently adopted.
// Future Gate invariant: exact Pub/Sub replay stays deterministic in automation, and
// live acceptance must never weaken acknowledgement semantics.
