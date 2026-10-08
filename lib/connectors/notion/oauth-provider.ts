import { ConnectorError, classifyConnectorHttpFailure } from "@/lib/connectors/errors";
import { NOTION_API_VERSION, NOTION_CAPABILITIES, NOTION_TOKEN_URL } from "@/lib/connectors/notion/constants";

const NOTION_INTROSPECTION_URL = "https://api.notion.com/v1/oauth/introspect";
const NOTION_CONTENT_SCOPES = new Map([
  ["read_content", NOTION_CAPABILITIES.readContent],
  ["insert_content", NOTION_CAPABILITIES.insertContent],
  ["update_content", NOTION_CAPABILITIES.updateContent],
  [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.readContent],
  [NOTION_CAPABILITIES.insertContent, NOTION_CAPABILITIES.insertContent],
  [NOTION_CAPABILITIES.updateContent, NOTION_CAPABILITIES.updateContent],
]);

function notionClientConfig() {
  const clientId = process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID;
  const clientSecret = process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Notion OAuth client configuration is missing.");
  return { clientId, clientSecret };
}

export function addNotionAuthorizationParameters(url: URL) {
  url.searchParams.set("owner", "user");
  url.searchParams.delete("scope");
  url.searchParams.delete("code_challenge");
  url.searchParams.delete("code_challenge_method");
  return url;
}

type NotionTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  workspace_id?: string;
  workspace_name?: string;
  workspace_icon?: string;
  bot_id?: string;
  owner?: { type?: string; user?: { id?: string; name?: string } };
  error?: string;
};

/** Notion's OAuth token response has no scopes; introspection is authoritative. */
export function parseNotionIntrospectedContentScopes(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) throw new Error("Notion capabilities could not be verified.");
  const tokens = value.trim().split(/[\s,]+/);
  const scopes = new Set<string>();
  for (const token of tokens) {
    const capability = NOTION_CONTENT_SCOPES.get(token);
    if (!capability) throw new Error("Notion returned an unsupported capability.");
    scopes.add(capability);
  }
  if (!scopes.has(NOTION_CAPABILITIES.readContent)) throw new Error("Notion read capability is unavailable.");
  return [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.insertContent, NOTION_CAPABILITIES.updateContent]
    .filter((scope) => scopes.has(scope));
}

export async function introspectNotionAccessToken(accessToken: string): Promise<string[]> {
  const { clientId, clientSecret } = notionClientConfig();
  let response: Response;
  try {
    response = await fetch(NOTION_INTROSPECTION_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        accept: "application/json",
        "content-type": "application/json",
        "notion-version": NOTION_API_VERSION,
      },
      body: JSON.stringify({ token: accessToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Notion capability verification is unavailable.");
  }
  const result = await response.json().catch(() => ({})) as { active?: unknown; scope?: unknown };
  if (!response.ok || result.active !== true) throw new Error("Notion token could not be verified.");
  return parseNotionIntrospectedContentScopes(result.scope);
}

/** Bind a previously stored token to the bot recorded by its original OAuth exchange. */
export async function verifyNotionTokenBotIdentity(accessToken: string, expectedBotId: string): Promise<void> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(expectedBotId)) {
    throw new Error("Notion connection identity is unavailable.");
  }
  let response: Response;
  try {
    response = await fetch("https://api.notion.com/v1/users/me", {
      headers: { authorization: `Bearer ${accessToken}`, "notion-version": NOTION_API_VERSION },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Notion connection identity could not be checked.");
  }
  const user = await response.json().catch(() => ({})) as { id?: unknown };
  if (!response.ok || user.id !== expectedBotId) throw new Error("Notion connection identity does not match.");
}

export async function exchangeNotionAuthorizationCode(input: { code: string; redirectUri: string }) {
  const { clientId, clientSecret } = notionClientConfig();
  const response = await fetch(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      accept: "application/json",
      "content-type": "application/json",
      "notion-version": NOTION_API_VERSION,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const token = await response.json().catch(() => ({})) as NotionTokenResponse;
  if (!response.ok || !token.access_token || !token.workspace_id) {
    throw new ConnectorError(response.ok ? { category: "authentication", code: `NOTION_${token.error ?? "OAUTH_REJECTED"}`.toUpperCase(), message: "Notion authorization was rejected.", retryable: false } : classifyConnectorHttpFailure(response.status));
  }
  const scopes = await introspectNotionAccessToken(token.access_token);
  return {
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    expiresAt: null,
    scopes,
    scopesConfirmedByProvider: true,
    externalAccountId: token.workspace_id,
    externalAccountLabel: token.workspace_name ?? token.workspace_id,
    safeMetadata: {
      capabilityVerification: "notion_token_introspection_v1",
      ...(token.bot_id ? { botId: token.bot_id } : {}),
      ...(token.owner?.user?.id ? { installerUserId: token.owner.user.id } : {}),
    },
  };
}
