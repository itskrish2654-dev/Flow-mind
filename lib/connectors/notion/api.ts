import { readConnectionSecret } from "@/lib/connectors/connection-vault";
import { ConnectorError, classifyConnectorHttpFailure } from "@/lib/connectors/errors";
import { NOTION_API_VERSION } from "@/lib/connectors/notion/constants";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";

const NOTION_API_TIMEOUT_MS = 12_000;

export async function getNotionAccessToken(input: { userId: string; connectionId: string; requiredCapabilities: string[] }) {
  const { data, error } = await createAdminClient().from("connector_connections")
    .select("id,status,provider_family,granted_scopes")
    .eq("id", input.connectionId).eq("user_id", input.userId).eq("provider_family", "notion").maybeSingle();
  if (error || !data || data.status !== "connected") throw new ConnectorError({ category: "authentication", code: "NOTION_RECONNECT_REQUIRED", message: "Reconnect Notion to continue.", retryable: false });
  const missing = input.requiredCapabilities.filter((scope) => !data.granted_scopes.includes(scope));
  if (missing.length) throw new ConnectorError({ category: "authorization", code: "NOTION_CAPABILITY_REQUIRED", message: "Reconnect Notion after enabling the required content capability.", retryable: false });
  return readConnectionSecret({ userId: input.userId, connectionId: input.connectionId, credentialKey: "access_token" });
}

export async function notionApiFetch(input: { userId: string; connectionId: string; requiredCapabilities: string[]; path: string; method?: "GET" | "POST" | "PATCH"; body?: unknown; write?: boolean }) {
  const token = await getNotionAccessToken(input);
  let response: Response;
  try {
    response = await fetch(`https://api.notion.com/v1${input.path}`, {
      method: input.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "notion-version": NOTION_API_VERSION, ...(input.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(NOTION_API_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError(input.write
      ? { category: "ambiguous_acknowledgement", code: "NOTION_RESPONSE_UNKNOWN", message: "Notion did not return an acknowledgement; the change may have happened.", retryable: false }
      : { category: "provider_unavailable", code: "NOTION_READ_TIMEOUT", message: "Notion did not respond in time.", retryable: true });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & { code?: string; message?: string };
  if (!response.ok) {
    if (response.status === 401) {
      await createAdminClient().from("connector_connections").update({ status: "expired", last_error_category: "authentication", updated_at: new Date().toISOString() }).eq("id", input.connectionId).eq("user_id", input.userId);
      await captureOperationalEvent({ level: "warn", event: "notion_reconnect_required", userId: input.userId, status: "expired", errorCategory: "authentication" });
    }
    const details = response.status === 404
      ? { category: "authorization" as const, code: "NOTION_RESOURCE_NOT_SHARED", message: "This Notion resource is not shared with the CrazyLoops connection.", retryable: false }
      : classifyConnectorHttpFailure(response.status, response.headers.get("retry-after"));
    throw new ConnectorError({ ...details, code: body.code ? `NOTION_${body.code.toUpperCase()}` : details.code });
  }
  return body;
}

export function notionApiErrorResult(error: unknown) {
  const details = error instanceof ConnectorError ? error.details : { category: "validation" as const, code: "NOTION_INPUT_INVALID", message: error instanceof Error ? error.message : "Notion input is invalid.", retryable: false };
  return { status: details.category === "ambiguous_acknowledgement" ? "ambiguous" as const : "failed" as const, acknowledged: false, externallyDelivered: false, output: {}, metadata: {}, error: details };
}
