import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { ConnectorError } from "../lib/connectors/errors";
import {
  assertGoogleOAuthHasDurableRefresh,
  assertGoogleReconnectAccount,
  canPreserveGoogleRefreshCredential,
  unionGoogleScopes,
  type ExistingGoogleConnection,
} from "../lib/connectors/google/oauth-finalization-core";
import { classifyGoogleInvalidGrant } from "../lib/connectors/google/oauth-provider";
import { GOOGLE_LEGACY_SHEETS_SCOPE, GOOGLE_SCOPES } from "../lib/connectors/google/scopes";
import {
  decideGoogleTokenAction,
  runTokenRefresh,
  type RefreshTokens,
} from "../lib/connectors/google/token-lifecycle-core";
import { assessConnectorPlan } from "../lib/connectors/planning";
import { getConnector } from "../lib/connectors/registry";

const migrationFile =
  "supabase/migrations/20260911053834_phase6b1a_google_oauth_token_lifecycle.sql";

function existingGoogle(
  overrides: Partial<ExistingGoogleConnection> = {},
): ExistingGoogleConnection {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    externalAccountId: "google-account-a",
    status: "connected",
    lastErrorCategory: null,
    grantedScopes: [GOOGLE_SCOPES.gmailReadonly],
    hasRefreshCredential: true,
    ...overrides,
  };
}

test("6B.1A-1 expired access token without a terminal error remains refreshable", () => {
  assert.equal(
    decideGoogleTokenAction({
      status: "expired",
      tokenExpiresAt: "2025-01-01T00:00:00.000Z",
      lastErrorCategory: null,
    }),
    "refresh",
  );
  assert.equal(
    decideGoogleTokenAction({
      status: "expired",
      tokenExpiresAt: "2025-01-01T00:00:00.000Z",
      lastErrorCategory: "authentication",
    }),
    "reconnect",
  );
});

test("6B.1A-2 refresh acquires the lease before reading or using credentials", async () => {
  const order: string[] = [];
  const result = await runTokenRefresh({
    claimLease: async () => { order.push("claim"); return true; },
    readRefreshToken: async () => { order.push("read"); return "opaque-refresh"; },
    requestTokens: async () => {
      order.push("provider");
      return { accessToken: "opaque-access", expiresAt: "2030-01-01T00:00:00.000Z" };
    },
    isReconnectRequiredError: () => false,
    finalizeTokens: async () => { order.push("finalize"); },
    markReconnectRequired: async () => { order.push("reconnect"); },
    releaseLease: async () => { order.push("release"); },
  });
  assert.deepEqual(order, ["claim", "read", "provider", "finalize", "release"]);
  assert.deepEqual(result, { refreshed: true, expiresAt: "2030-01-01T00:00:00.000Z" });
});

test("6B.1A-3 successful refresh restores metadata through one transactional finalizer", async () => {
  let finalized: RefreshTokens | null = null;
  await runTokenRefresh({
    claimLease: async () => true,
    readRefreshToken: async () => "opaque-refresh",
    requestTokens: async () => ({
      accessToken: "opaque-access",
      expiresAt: "2030-01-01T00:00:00.000Z",
      grantedScopes: [GOOGLE_SCOPES.gmailSend],
    }),
    isReconnectRequiredError: () => false,
    finalizeTokens: async (tokens) => { finalized = tokens; },
    markReconnectRequired: async () => assert.fail("healthy refresh was downgraded"),
    releaseLease: async () => undefined,
  });
  assert.deepEqual(finalized, {
    accessToken: "opaque-access",
    expiresAt: "2030-01-01T00:00:00.000Z",
    grantedScopes: [GOOGLE_SCOPES.gmailSend],
  });
  const migration = await readFile(migrationFile, "utf8");
  assert.match(migration, /finalize_google_token_refresh[\s\S]*status = 'connected'/);
  assert.match(migration, /last_error_category = null/);
});

test("6B.1A-4 a rotated refresh credential reaches the atomic commit unchanged", async () => {
  const rotated = crypto.randomUUID();
  let finalizedRefresh: string | undefined;
  const result = await runTokenRefresh({
    claimLease: async () => true,
    readRefreshToken: async () => crypto.randomUUID(),
    requestTokens: async () => ({
      accessToken: crypto.randomUUID(),
      refreshToken: rotated,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    isReconnectRequiredError: () => false,
    finalizeTokens: async (tokens) => { finalizedRefresh = tokens.refreshToken; },
    markReconnectRequired: async () => assert.fail("rotation was rejected"),
    releaseLease: async () => undefined,
  });
  assert.equal(finalizedRefresh, rotated);
  assert.equal("refreshToken" in result, false);
});

test("6B.1A-5 an existing healthy reconnect may preserve its durable refresh credential", () => {
  const existing = existingGoogle();
  assert.equal(canPreserveGoogleRefreshCredential(existing), true);
  assert.doesNotThrow(() => assertGoogleOAuthHasDurableRefresh({ existing }));
});

test("6B.1A-6 a new Google connection without a refresh token fails closed", () => {
  assert.throws(
    () => assertGoogleOAuthHasDurableRefresh({ existing: null }),
    /durable refresh credential/i,
  );
  assert.doesNotThrow(() =>
    assertGoogleOAuthHasDurableRefresh({
      existing: null,
      returnedRefreshToken: "opaque-refresh",
    }),
  );
});

test("6B.1A-7 credential failure cannot publish a partial connected Google row", async () => {
  const migration = await readFile(migrationFile, "utf8");
  const insertConnection = migration.indexOf("insert into public.connector_connections");
  const accessWrite = migration.indexOf("'access_token', 'oauth_access_token'", insertConnection);
  const refreshWrite = migration.indexOf("'refresh_token', 'oauth_refresh_token'", accessWrite);
  const publishConnected = migration.indexOf("status = 'connected'", refreshWrite);
  assert.ok(migration.trimStart().startsWith("begin;"));
  assert.ok(insertConnection >= 0 && accessWrite > insertConnection);
  assert.ok(refreshWrite > accessWrite && publishConnected > refreshWrite);
  assert.ok(migration.trimEnd().endsWith("commit;"));
});

test("6B.1A-8 failed reconnect leaves the existing refresh credential untouched", async () => {
  const migration = await readFile(migrationFile, "utf8");
  const oauthFunction = migration.slice(
    migration.indexOf("create or replace function public.finalize_google_oauth_connection"),
    migration.indexOf("create or replace function public.finalize_google_token_refresh"),
  );
  assert.match(oauthFunction, /if p_refresh_credential is not null then[\s\S]*on conflict \(connection_id, credential_key\) do update/);
  assert.doesNotMatch(oauthFunction, /delete from public\.connector_connection_credentials/);
  assert.match(oauthFunction, /p_refresh_credential is null and not \(v_refreshable and v_has_refresh\)/);
});

test("6B.1A-9 invalid refresh becomes reconnect-required and still releases its lease", async () => {
  const order: string[] = [];
  await assert.rejects(
    runTokenRefresh({
      claimLease: async () => { order.push("claim"); return true; },
      readRefreshToken: async () => { order.push("read"); return "opaque-refresh"; },
      requestTokens: async () => {
        order.push("provider");
        throw new ConnectorError({
          category: "authentication",
          code: "GOOGLE_REFRESH_REVOKED",
          message: "Reconnect Google to continue.",
          retryable: false,
        });
      },
      isReconnectRequiredError: (error) =>
        error instanceof ConnectorError && error.details.category === "authentication",
      finalizeTokens: async () => assert.fail("invalid grant was finalized"),
      markReconnectRequired: async () => { order.push("reconnect"); },
      releaseLease: async () => { order.push("release"); },
    }),
    /Reconnect Google/,
  );
  assert.deepEqual(order, ["claim", "read", "provider", "reconnect", "release"]);
});

test("6B.1A-10 concurrent refresh attempts do not read the vault without the lease", async () => {
  let claimed = false;
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let vaultReads = 0;
  const operations = () => ({
    claimLease: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    readRefreshToken: async () => { vaultReads += 1; return "opaque-refresh"; },
    requestTokens: async () => {
      await providerGate;
      return { accessToken: "opaque-access", expiresAt: "2030-01-01T00:00:00.000Z" };
    },
    isReconnectRequiredError: () => false,
    finalizeTokens: async () => undefined,
    markReconnectRequired: async () => undefined,
    releaseLease: async () => { claimed = false; },
  });
  const first = runTokenRefresh(operations());
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runTokenRefresh(operations());
  assert.deepEqual(second, { refreshed: false, reason: "refresh_in_progress" });
  assert.equal(vaultReads, 1);
  releaseProvider();
  await first;
});

test("6B.1A-10b transient or persistence failures preserve the durable refresh credential", async () => {
  for (const failurePoint of ["provider", "finalize"] as const) {
    let reconnects = 0;
    await assert.rejects(
      runTokenRefresh({
        claimLease: async () => true,
        readRefreshToken: async () => "opaque-refresh",
        requestTokens: async () => {
          if (failurePoint === "provider") {
            throw new ConnectorError({
              category: "provider_unavailable",
              code: "PROVIDER_UNAVAILABLE",
              message: "Google is temporarily unavailable.",
              retryable: true,
            });
          }
          return { accessToken: "opaque-access", expiresAt: "2030-01-01T00:00:00.000Z" };
        },
        isReconnectRequiredError: (error) =>
          error instanceof ConnectorError && error.details.category === "authentication",
        finalizeTokens: async () => {
          if (failurePoint === "finalize") throw new Error("database unavailable");
        },
        markReconnectRequired: async () => { reconnects += 1; },
        releaseLease: async () => undefined,
      }),
    );
    assert.equal(reconnects, 0, `${failurePoint} failure must not destroy refreshability`);
  }
});

test("6B.1A-11 transactional finalizers are service-role-only and owner-bound", async () => {
  const migration = await readFile(migrationFile, "utf8");
  const finalizer = await readFile("lib/connectors/google/connection-finalization.ts", "utf8");
  assert.match(migration, /security invoker/);
  assert.match(migration, /revoke all on function public\.finalize_google_oauth_connection[^;]+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.finalize_google_oauth_connection[^;]+to service_role/);
  assert.match(migration, /where id = p_connection_id and user_id = p_user_id/);
  assert.match(finalizer, /\.eq\("user_id", input\.userId\)/);
});

test("6B.1A-12 intended reconnect account mismatch remains rejected", () => {
  assert.throws(
    () => assertGoogleReconnectAccount(existingGoogle(), "google-account-b"),
    /different account/,
  );
  assert.doesNotThrow(() =>
    assertGoogleReconnectAccount(existingGoogle(), "google-account-a"),
  );
});

test("6B.1A-13 Gmail and Sheets share an account but remain scope-isolated", () => {
  const connection = {
    id: "google-account",
    connectorId: "google",
    providerFamily: "google",
    status: "connected" as const,
    grantedScopes: [GOOGLE_SCOPES.driveFile],
  };
  const gmail = getConnector("google_gmail")!;
  const sheets = getConnector("google_sheets")!;
  assert.equal(
    assessConnectorPlan(gmail.manifest, gmail.manifest.actions[0], [connection], "production", connection.id).status,
    "ADDITIONAL_SCOPE_REQUIRED",
  );
  assert.equal(
    assessConnectorPlan(sheets.manifest, sheets.manifest.actions[0], [connection], "production", connection.id).status,
    "SUPPORTED",
  );
  assert.deepEqual(
    unionGoogleScopes([GOOGLE_SCOPES.driveFile], [GOOGLE_SCOPES.gmailSend], GOOGLE_LEGACY_SHEETS_SCOPE),
    [GOOGLE_SCOPES.driveFile, GOOGLE_SCOPES.gmailSend],
  );
});

test("6B.1A-13b OAuth scope union uses the locked current row and cannot lose a concurrent grant", async () => {
  const scopeA = "openid";
  const scopeB = GOOGLE_SCOPES.driveFile;
  const scopeC = GOOGLE_SCOPES.gmailSend;
  assert.deepEqual(
    unionGoogleScopes(
      [scopeA, scopeB],
      [scopeA, scopeC, GOOGLE_LEGACY_SHEETS_SCOPE],
      GOOGLE_LEGACY_SHEETS_SCOPE,
    ),
    [scopeA, scopeB, scopeC],
  );

  const migration = await readFile(migrationFile, "utf8");
  const oauthFunction = migration.slice(
    migration.indexOf("create or replace function public.finalize_google_oauth_connection"),
    migration.indexOf("create or replace function public.finalize_google_token_refresh"),
  );
  const rowLock = oauthFunction.indexOf("for update");
  const scopeMerge = oauthFunction.indexOf("coalesce(v_connection.granted_scopes");
  assert.ok(rowLock >= 0 && scopeMerge > rowLock);
  assert.match(oauthFunction, /coalesce\(v_connection\.granted_scopes, '\{\}'::text\[\]\)[\s\S]*\|\| p_granted_scopes/);
  assert.match(oauthFunction, /where scope <> 'https:\/\/www\.googleapis\.com\/auth\/spreadsheets'/);
  assert.doesNotMatch(oauthFunction, /granted_scopes = p_granted_scopes/);
});

test("6B.1A-13c token refresh cannot overwrite scopes granted by a concurrent OAuth flow", async () => {
  const [migration, refreshRuntime] = await Promise.all([
    readFile(migrationFile, "utf8"),
    readFile("lib/connectors/token-refresh.ts", "utf8"),
  ]);
  const refreshFunction = migration.slice(
    migration.indexOf("create or replace function public.finalize_google_token_refresh"),
    migration.indexOf("create or replace function public.run_connector_maintenance"),
  );
  assert.doesNotMatch(refreshFunction, /p_granted_scopes/);
  assert.doesNotMatch(refreshFunction, /granted_scopes\s*=/);
  assert.doesNotMatch(refreshRuntime, /p_granted_scopes/);
});

test("6B.1A-13d invalid_grant classification is truthful to the Google token request purpose", async () => {
  assert.deepEqual(classifyGoogleInvalidGrant("authorization_code"), {
    category: "validation",
    code: "GOOGLE_AUTHORIZATION_CODE_REJECTED",
    message: "Google authorization could not be completed. Start the connection again.",
    retryable: false,
  });
  assert.deepEqual(classifyGoogleInvalidGrant("refresh_token"), {
    category: "authentication",
    code: "GOOGLE_REFRESH_REVOKED",
    message: "Reconnect Google to continue.",
    retryable: false,
  });
  const provider = await readFile("lib/connectors/google/oauth-provider.ts", "utf8");
  assert.match(provider, /tokenRequest\("authorization_code", new URLSearchParams/);
  assert.match(provider, /tokenRequest\("refresh_token", new URLSearchParams/);
});

test("6B.1A-14 scheduled maintenance preserves refreshable Google OAuth rows", async () => {
  const migration = await readFile(migrationFile, "utf8");
  const maintenance = migration.slice(migration.indexOf("create or replace function public.run_connector_maintenance"));
  assert.match(maintenance, /connection\.provider_family = 'google'/);
  assert.match(maintenance, /credential\.credential_key = 'refresh_token'/);
  assert.match(maintenance, /and not \([\s\S]*exists\(/);
});

test("6B.1A-15 credentials remain server-only and never appear in callback responses", async () => {
  const [callback, finalizer, refresh, client] = await Promise.all([
    readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8"),
    readFile("lib/connectors/google/connection-finalization.ts", "utf8"),
    readFile("lib/connectors/token-refresh.ts", "utf8"),
    readFile("components/connections-list.tsx", "utf8"),
  ]);
  assert.match(finalizer, /^import "server-only";/);
  assert.match(refresh, /^import "server-only";/);
  assert.doesNotMatch(callback, /NextResponse\.json\([^)]*(?:accessToken|refreshToken|tokens)/);
  assert.doesNotMatch(client, /access_token|refresh_token|client_secret|ciphertext|auth_tag/i);
});

test("6B.1A-16 Gmail product maturity and execution gates remain unchanged", () => {
  for (const capabilityId of [
    "gmail_new_email",
    "gmail_new_email_matching_search",
    "gmail_send_email",
    "gmail_reply_to_email",
  ] as const) {
    const capability = CAPABILITY_REGISTRY[capabilityId];
    assert.equal(capability.maturity, "REVIEWED");
    assert.equal(capability.onboarding.available, false);
    assert.equal(capability.availableInTest, false);
    assert.equal(capability.availableInProduction, false);
  }
});
