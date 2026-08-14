import { ConnectorError, classifyConnectorHttpFailure } from "@/lib/connectors/errors";
import { NOTION_API_VERSION, NOTION_TOKEN_URL } from "@/lib/connectors/notion/constants";

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

export async function exchangeNotionAuthorizationCode(input: { code: string; redirectUri: string; requestedScopes: string[] }) {
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
  return {
    accessToken: token.access_token,
    ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    expiresAt: null,
    scopes: input.requestedScopes,
    externalAccountId: token.workspace_id,
    externalAccountLabel: token.workspace_name ?? token.workspace_id,
    safeMetadata: {
      ...(token.bot_id ? { botId: token.bot_id } : {}),
      ...(token.owner?.user?.id ? { installerUserId: token.owner.user.id } : {}),
    },
  };
}
