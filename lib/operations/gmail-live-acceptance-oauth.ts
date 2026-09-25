import "@/lib/server-only-runtime";

import type { OAuthTokenSet } from "@/lib/connectors/oauth-exchange";
import {
  GMAIL_LIVE_ACCEPTANCE_MARKER,
  GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES,
  hasExactGmailLiveAcceptanceScopes,
  isGmailLiveAcceptanceOwner,
  readGmailLiveAcceptancePolicy,
  type GmailLiveAcceptanceConfig,
  type GmailLiveAcceptanceEnvironment,
} from "@/lib/operations/gmail-live-acceptance-policy";
import type { Json } from "@/lib/supabase/types";

export const GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID = "google_gmail" as const;
export const GMAIL_LIVE_ACCEPTANCE_CALLBACK_PATH = "/api/connectors/oauth/google_gmail/callback" as const;

type AcceptanceAuthorization = {
  state: string;
  codeChallenge: string;
  scopes: string[];
  returnPath: string;
};

type StartDependencies = {
  createAuthorization?: (input: {
    userId: string;
    environment: GmailLiveAcceptanceEnvironment;
  }) => Promise<AcceptanceAuthorization>;
  buildAuthorizationUrl?: (input: {
    connectorId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: string[];
    selectAccount: boolean;
  }) => URL;
  getSiteOrigin?: (fallbackOrigin?: string) => string;
};

export type GmailLiveAcceptanceOAuthState = Readonly<{
  userId: string;
  connectorId: string;
  scopes: readonly string[];
  operationKey: string | null | undefined;
  connectionId: string | null | undefined;
}>;

export type GmailLiveAcceptanceCallbackContext = Readonly<{
  config: GmailLiveAcceptanceConfig;
}>;

export type ExistingAcceptanceGoogleConnection = Readonly<{
  id: string;
  user_id: string;
  connector_id: string;
  provider_family: string;
  external_account_id: string;
  safe_metadata: Json;
}>;

type FinalizationDependencies = {
  findExistingConnection?: (input: {
    userId: string;
    externalAccountId: string;
  }) => Promise<ExistingAcceptanceGoogleConnection | null>;
  finalizeConnection?: (input: {
    userId: string;
    oauthConnectorId: string;
    intendedConnectionId: string | null;
    connectionResolution: Readonly<{ mode: "new_only" }>;
    tokens: OAuthTokenSet;
  }) => Promise<{ id: string; grantedScopes: string[] }>;
  revokeToken?: (token: string) => Promise<boolean>;
};

export async function startGmailLiveAcceptanceOAuth(input: {
  userId: string | null;
  requestOrigin: string;
  environment?: GmailLiveAcceptanceEnvironment;
  dependencies?: StartDependencies;
}) {
  const environment = input.environment ?? process.env;
  const policy = readGmailLiveAcceptancePolicy(environment);
  if (
    policy.status !== "enabled"
    || !input.userId
    || !isGmailLiveAcceptanceOwner(input.userId, environment)
  ) {
    throw new Error("Gmail live acceptance is unavailable.");
  }

  const createAuthorization = input.dependencies?.createAuthorization
    ?? (await import("@/lib/connectors/oauth")).createGmailLiveAcceptanceOAuthAuthorization;
  const buildAuthorizationUrl = input.dependencies?.buildAuthorizationUrl
    ?? (await import("@/lib/connectors/oauth-exchange")).buildAuthorizationUrl;
  const getSiteOrigin = input.dependencies?.getSiteOrigin
    ?? (await import("@/lib/site-origin")).getSiteOrigin;
  const authorization = await createAuthorization({ userId: input.userId, environment });
  const redirectUri = new URL(GMAIL_LIVE_ACCEPTANCE_CALLBACK_PATH, getSiteOrigin(input.requestOrigin)).toString();
  const authorizationUrl = buildAuthorizationUrl({
    connectorId: GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID,
    redirectUri,
    state: authorization.state,
    codeChallenge: authorization.codeChallenge,
    scopes: [...GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES],
    selectAccount: true,
  });
  return { authorizationUrl: authorizationUrl.toString(), redirectUri };
}

export function getGmailLiveAcceptanceCallbackContext(input: {
  connectorId: string;
  userId: string;
  oauth: GmailLiveAcceptanceOAuthState;
  environment?: GmailLiveAcceptanceEnvironment;
}): GmailLiveAcceptanceCallbackContext | null {
  const environment = input.environment ?? process.env;
  const policy = readGmailLiveAcceptancePolicy(environment);
  if (
    input.connectorId !== GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID
    || policy.status !== "enabled"
    || !isGmailLiveAcceptanceOwner(input.userId, environment)
    || input.oauth.userId !== input.userId
    || input.oauth.connectorId !== GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID
    || input.oauth.operationKey !== GMAIL_LIVE_ACCEPTANCE_MARKER
    || input.oauth.connectionId != null
    || !hasExactGmailLiveAcceptanceScopes(input.oauth.scopes)
  ) {
    return null;
  }
  return { config: policy.config };
}

export function withGmailLiveAcceptanceMetadata(
  tokens: OAuthTokenSet,
  context: GmailLiveAcceptanceCallbackContext,
): OAuthTokenSet {
  return {
    ...tokens,
    safeMetadata: {
      acceptanceMarker: GMAIL_LIVE_ACCEPTANCE_MARKER,
      acceptanceRunId: context.config.runId,
    },
  };
}

export function hasValidGmailLiveAcceptanceTokens(
  tokens: OAuthTokenSet,
  context: GmailLiveAcceptanceCallbackContext,
): boolean {
  return tokens.scopesConfirmedByProvider === true
    && hasExactGmailLiveAcceptanceScopes(tokens.scopes)
    && typeof tokens.externalAccountLabel === "string"
    && tokens.externalAccountLabel.trim().toLowerCase() === context.config.accountEmail;
}

async function findExistingConnection(input: {
  userId: string;
  externalAccountId: string;
}): Promise<ExistingAcceptanceGoogleConnection | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("connector_connections")
    .select("id,user_id,connector_id,provider_family,external_account_id,safe_metadata")
    .eq("user_id", input.userId)
    .eq("connector_id", "google")
    .eq("provider_family", "google")
    .eq("external_account_id", input.externalAccountId)
    .maybeSingle();
  if (error) throw new Error("Gmail live acceptance is unavailable.");
  return data;
}

export async function finalizeGmailLiveAcceptanceConnection(input: {
  userId: string;
  tokens: OAuthTokenSet;
  context: GmailLiveAcceptanceCallbackContext;
  dependencies?: FinalizationDependencies;
}) {
  const revokeToken = input.dependencies?.revokeToken
    ?? (await import("@/lib/connectors/google/oauth-provider")).revokeGoogleToken;
  try {
    if (!hasValidGmailLiveAcceptanceTokens(input.tokens, input.context)) {
      throw new Error("Gmail live acceptance is unavailable.");
    }
    const loadExisting = input.dependencies?.findExistingConnection ?? findExistingConnection;
    const existing = await loadExisting({
      userId: input.userId,
      externalAccountId: input.tokens.externalAccountId,
    });
    if (existing) {
      throw new Error("Gmail live acceptance is unavailable.");
    }
    const finalizeConnection = input.dependencies?.finalizeConnection
      ?? (await import("@/lib/connectors/google/connection-finalization")).finalizeGoogleOAuthConnection;
    return await finalizeConnection({
      userId: input.userId,
      oauthConnectorId: GMAIL_LIVE_ACCEPTANCE_CONNECTOR_ID,
      intendedConnectionId: null,
      connectionResolution: { mode: "new_only" },
      tokens: withGmailLiveAcceptanceMetadata(input.tokens, input.context),
    });
  } catch {
    await revokeToken(input.tokens.refreshToken ?? input.tokens.accessToken).catch(() => false);
    throw new Error("Gmail live acceptance authorization could not be completed.");
  }
}
