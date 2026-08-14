import { classifyConnectorHttpFailure, ConnectorError } from "@/lib/connectors/errors";

export const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function googleClientConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth client configuration is missing.");
  return { clientId, clientSecret };
}

export function addGoogleAuthorizationParameters(url: URL, input?: { loginHint?: string | null; selectAccount?: boolean }) {
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", input?.selectAccount ? "select_account consent" : "consent");
  if (input?.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url;
}

type GoogleTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

async function tokenRequest(params: URLSearchParams): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as GoogleTokenResponse;
  if (!response.ok || !body.access_token) throw new ConnectorError(classifyConnectorHttpFailure(response.status));
  return body;
}

export async function exchangeGoogleAuthorizationCode(input: { code: string; verifier: string; redirectUri: string; requestedScopes: string[] }) {
  const { clientId, clientSecret } = googleClientConfig();
  const token = await tokenRequest(new URLSearchParams({
    code: input.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  }));
  const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const identity = await identityResponse.json().catch(() => ({})) as { sub?: string; email?: string; email_verified?: boolean };
  if (!identityResponse.ok || !identity.sub || !identity.email || identity.email_verified === false) {
    throw new Error("Google account identity could not be verified.");
  }
  return {
    accessToken: token.access_token!,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    expiresAt: new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000).toISOString(),
    scopes: Array.from(new Set((token.scope?.split(/\s+/).filter(Boolean) ?? input.requestedScopes))),
    externalAccountId: identity.sub,
    externalAccountLabel: identity.email,
  };
}

export async function refreshGoogleAccessToken(refreshToken: string) {
  const { clientId, clientSecret } = googleClientConfig();
  const token = await tokenRequest(new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  }));
  return {
    accessToken: token.access_token!,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    expiresAt: new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000).toISOString(),
    ...(token.scope ? { grantedScopes: token.scope.split(/\s+/).filter(Boolean) } : {}),
  };
}

export async function revokeGoogleToken(token: string) {
  const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  return response.ok || response.status === 400;
}
