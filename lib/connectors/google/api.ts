import { readConnectionSecret } from "@/lib/connectors/connection-vault";
import { ConnectorError, classifyConnectorHttpFailure } from "@/lib/connectors/errors";
import { refreshGoogleAccessToken } from "@/lib/connectors/google/oauth-provider";
import { refreshConnectionToken } from "@/lib/connectors/token-refresh";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";

const GOOGLE_API_TIMEOUT_MS = 12_000;

export async function getGoogleAccessToken(input: { userId: string; connectionId: string; requiredScopes: string[] }) {
  const admin = createAdminClient();
  let result = await admin.from("connector_connections")
    .select("id,provider_family,status,granted_scopes,token_expires_at")
    .eq("id", input.connectionId).eq("user_id", input.userId).eq("provider_family", "google").maybeSingle();
  if (result.error || !result.data || result.data.status !== "connected") {
    throw new ConnectorError({ category: "authentication", code: "GOOGLE_RECONNECT_REQUIRED", message: "Reconnect Google to continue.", retryable: false });
  }
  const missing = input.requiredScopes.filter((scope) => !result.data!.granted_scopes.includes(scope));
  if (missing.length) {
    throw new ConnectorError({ category: "authorization", code: "GOOGLE_ADDITIONAL_SCOPE_REQUIRED", message: "FlowMind needs additional Google permission for this workflow.", retryable: false });
  }
  if (!result.data.token_expires_at || Date.parse(result.data.token_expires_at) < Date.now() + 60_000) {
    try {
      await refreshConnectionToken({ userId: input.userId, connectionId: input.connectionId, refresh: refreshGoogleAccessToken });
    } catch (error) {
      await captureOperationalEvent({ level: "warn", event: "google_reconnect_required", userId: input.userId, status: "expired", errorCategory: "authentication" });
      throw error;
    }
    result = await admin.from("connector_connections")
      .select("id,provider_family,status,granted_scopes,token_expires_at")
      .eq("id", input.connectionId).eq("user_id", input.userId).eq("provider_family", "google").maybeSingle();
    if (!result.data || result.data.status !== "connected") throw new Error("Reconnect Google to continue.");
  }
  return readConnectionSecret({ userId: input.userId, connectionId: input.connectionId, credentialKey: "access_token" });
}

export async function googleApiFetch(input: {
  userId: string;
  connectionId: string;
  requiredScopes: string[];
  url: string;
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const accessToken = await getGoogleAccessToken(input);
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...input.headers,
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    });
  } catch {
    if (!input.method || input.method === "GET") {
      throw new ConnectorError({ category: "provider_unavailable", code: "GOOGLE_READ_TIMEOUT", message: "Google did not respond in time.", retryable: true });
    }
    throw new ConnectorError({ category: "ambiguous_acknowledgement", code: "GOOGLE_RESPONSE_UNKNOWN", message: "Google did not return an acknowledgement; the action may have happened.", retryable: false });
  }
  if (!response.ok) {
    const details = classifyConnectorHttpFailure(response.status, response.headers.get("retry-after"));
    if (response.status === 401) {
      await createAdminClient().from("connector_connections").update({ status: "expired", last_error_category: "authentication", updated_at: new Date().toISOString() }).eq("id", input.connectionId).eq("user_id", input.userId);
      await captureOperationalEvent({ level: "warn", event: "google_reconnect_required", userId: input.userId, status: "expired", errorCategory: "authentication" });
    }
    throw new ConnectorError(details);
  }
  return response;
}

export function googleApiErrorResult(error: unknown) {
  const details = error instanceof ConnectorError ? error.details : {
    category: "ambiguous_acknowledgement" as const,
    code: "GOOGLE_RESPONSE_UNKNOWN",
    message: "Google did not return an acknowledgement; the action may have happened.",
    retryable: false,
  };
  return {
    status: details.category === "ambiguous_acknowledgement" ? "ambiguous" as const : "failed" as const,
    acknowledged: false,
    externallyDelivered: false,
    output: {},
    metadata: {},
    error: details,
  };
}
