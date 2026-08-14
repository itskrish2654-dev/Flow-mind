import { ConnectorError, classifyConnectorHttpFailure } from "@/lib/connectors/errors";

export const SLACK_AUTHORIZATION_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";

function slackClientConfig() {
  const clientId = process.env.FLOWMIND_CONNECTOR_SLACK_CLIENT_ID;
  const clientSecret = process.env.FLOWMIND_CONNECTOR_SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Slack OAuth client configuration is missing.");
  return { clientId, clientSecret };
}

export function addSlackAuthorizationParameters(url: URL) {
  return url;
}

type SlackTokenResponse = {
  ok?: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  app_id?: string;
  bot_user_id?: string;
  team?: { id?: string; name?: string };
};

export async function exchangeSlackAuthorizationCode(input: { code: string; verifier: string; redirectUri: string; requestedScopes: string[] }) {
  const { clientId, clientSecret } = slackClientConfig();
  const response = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const token = await response.json().catch(() => ({})) as SlackTokenResponse;
  if (!response.ok || !token.ok || !token.access_token || !token.team?.id) {
    throw new ConnectorError(response.ok ? { category: "authentication", code: `SLACK_${token.error ?? "OAUTH_REJECTED"}`.toUpperCase(), message: "Slack authorization was rejected.", retryable: false } : classifyConnectorHttpFailure(response.status, response.headers.get("retry-after")));
  }
  return {
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1_000).toISOString() : null,
    scopes: Array.from(new Set(token.scope?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? input.requestedScopes)),
    externalAccountId: token.team.id,
    externalAccountLabel: token.team.name ?? token.team.id,
    safeMetadata: {
      ...(token.app_id ? { appId: token.app_id } : {}),
      ...(token.bot_user_id ? { botUserId: token.bot_user_id } : {}),
    },
  };
}

export async function revokeSlackToken(token: string) {
  const response = await fetch("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  return body.ok === true || body.error === "token_revoked" || body.error === "invalid_auth";
}
