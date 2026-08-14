import "server-only";
import { getConnector } from "@/lib/connectors/registry";
import { addGoogleAuthorizationParameters, exchangeGoogleAuthorizationCode } from "@/lib/connectors/google/oauth-provider";
import { addSlackAuthorizationParameters, exchangeSlackAuthorizationCode } from "@/lib/connectors/slack/oauth-provider";
import { addNotionAuthorizationParameters, exchangeNotionAuthorizationCode } from "@/lib/connectors/notion/oauth-provider";

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scopes: string[];
  externalAccountId: string;
  externalAccountLabel?: string;
  safeMetadata?: Record<string, string | number | boolean | null>;
};

export function buildAuthorizationUrl(input: { connectorId: string; redirectUri: string; state: string; codeChallenge: string; scopes: string[]; loginHint?: string | null; selectAccount?: boolean }) {
  const registered = getConnector(input.connectorId);
  const auth = registered?.manifest.auth;
  if (!registered || auth?.type !== "oauth2" || !auth.authorizationUrl) throw new Error("OAuth is not configured for this connector.");
  const clientId = registered.manifest.providerFamily === "google" ? process.env.GOOGLE_OAUTH_CLIENT_ID : process.env[`FLOWMIND_CONNECTOR_${registered.manifest.providerFamily.toUpperCase()}_CLIENT_ID`];
  if (!clientId && registered.manifest.status !== "INTERNAL") throw new Error("OAuth client configuration is missing.");
  const url = new URL(auth.authorizationUrl);
  url.searchParams.set("client_id", clientId ?? "flowmind-internal-test"); url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code"); url.searchParams.set("state", input.state);
  if (input.scopes.length) url.searchParams.set("scope", input.scopes.join(registered.manifest.providerFamily === "slack" ? "," : " "));
  if (auth.pkceRequired) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (registered.manifest.providerFamily === "google") return addGoogleAuthorizationParameters(url, input);
  if (registered.manifest.providerFamily === "slack") return addSlackAuthorizationParameters(url);
  if (registered.manifest.providerFamily === "notion") return addNotionAuthorizationParameters(url);
  return url;
}

export async function exchangeAuthorizationCode(input: { connectorId: string; code: string; verifier: string; redirectUri: string; scopes: string[] }): Promise<OAuthTokenSet> {
  const registered = getConnector(input.connectorId);
  if (!registered || registered.manifest.auth.type !== "oauth2") throw new Error("OAuth is not configured for this connector.");
  if (registered.manifest.status === "INTERNAL" && process.env.NODE_ENV !== "production") {
    if (input.code !== "valid-test-code") throw new Error("The test authorization code was rejected.");
    return { accessToken: "test-access-token", refreshToken: "test-refresh-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: input.scopes, externalAccountId: "test-account", externalAccountLabel: "Internal test account" };
  }
  if (registered.manifest.providerFamily === "google") {
    return exchangeGoogleAuthorizationCode({ code: input.code, verifier: input.verifier, redirectUri: input.redirectUri, requestedScopes: input.scopes });
  }
  if (registered.manifest.providerFamily === "slack") {
    return exchangeSlackAuthorizationCode({ code: input.code, verifier: input.verifier, redirectUri: input.redirectUri, requestedScopes: input.scopes });
  }
  if (registered.manifest.providerFamily === "notion") {
    return exchangeNotionAuthorizationCode({ code: input.code, redirectUri: input.redirectUri, requestedScopes: input.scopes });
  }
  throw new Error("No production OAuth exchange adapter is registered for this connector.");
}
