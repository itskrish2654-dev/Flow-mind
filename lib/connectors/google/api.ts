import { readConnectionSecret } from "@/lib/connectors/connection-vault";
import { ConnectorError, classifyConnectorHttpFailure } from "@/lib/connectors/errors";
import { refreshGoogleAccessToken } from "@/lib/connectors/google/oauth-provider";
import { decideGoogleTokenAction } from "@/lib/connectors/google/token-lifecycle-core";
import { refreshConnectionToken } from "@/lib/connectors/token-refresh";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";

const GOOGLE_API_TIMEOUT_MS = 12_000;
const CONCURRENT_REFRESH_WAIT_MS = [50, 100, 200] as const;

async function loadGoogleConnection(userId: string, connectionId: string) {
  return createAdminClient()
    .from("connector_connections")
    .select("id,provider_family,status,granted_scopes,token_expires_at,last_error_category")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .eq("provider_family", "google")
    .maybeSingle();
}

function reconnectRequired(): never {
  throw new ConnectorError({
    category: "authentication",
    code: "GOOGLE_RECONNECT_REQUIRED",
    message: "Reconnect Google to continue.",
    retryable: false,
  });
}

function assertRequiredScopes(grantedScopes: string[], requiredScopes: string[]) {
  const missing = requiredScopes.filter((scope) => !grantedScopes.includes(scope));
  if (missing.length) {
    throw new ConnectorError({
      category: "authorization",
      code: "GOOGLE_ADDITIONAL_SCOPE_REQUIRED",
      message: "CrazyLoops needs additional Google permission for this workflow.",
      retryable: false,
    });
  }
}

export async function getGoogleAccessToken(input: { userId: string; connectionId: string; requiredScopes: string[] }) {
  let result = await loadGoogleConnection(input.userId, input.connectionId);
  if (result.error || !result.data) reconnectRequired();
  assertRequiredScopes(result.data.granted_scopes, input.requiredScopes);

  const decision = decideGoogleTokenAction({
    status: result.data.status,
    tokenExpiresAt: result.data.token_expires_at,
    lastErrorCategory: result.data.last_error_category,
  });
  if (decision === "reconnect") reconnectRequired();
  if (decision === "refresh") {
    try {
      const refresh = await refreshConnectionToken({
        userId: input.userId,
        connectionId: input.connectionId,
        connectorId: "google",
        refresh: refreshGoogleAccessToken,
      });
      if (!refresh.refreshed) {
        for (const waitMs of CONCURRENT_REFRESH_WAIT_MS) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          result = await loadGoogleConnection(input.userId, input.connectionId);
          if (
            result.data &&
            decideGoogleTokenAction({
              status: result.data.status,
              tokenExpiresAt: result.data.token_expires_at,
              lastErrorCategory: result.data.last_error_category,
            }) === "use_access_token"
          ) {
            break;
          }
        }
      }
    } catch (error) {
      const failedConnection = await loadGoogleConnection(input.userId, input.connectionId);
      if (
        failedConnection.data &&
        decideGoogleTokenAction({
          status: failedConnection.data.status,
          tokenExpiresAt: failedConnection.data.token_expires_at,
          lastErrorCategory: failedConnection.data.last_error_category,
        }) === "reconnect"
      ) {
        await captureOperationalEvent({ level: "warn", event: "google_reconnect_required", userId: input.userId, status: "expired", errorCategory: "authentication" });
      }
      throw error;
    }
    result = await loadGoogleConnection(input.userId, input.connectionId);
    if (
      !result.data ||
      decideGoogleTokenAction({
        status: result.data.status,
        tokenExpiresAt: result.data.token_expires_at,
        lastErrorCategory: result.data.last_error_category,
      }) !== "use_access_token"
    ) {
      throw new ConnectorError({
        category: "provider_unavailable",
        code: "GOOGLE_REFRESH_IN_PROGRESS",
        message: "Google authorization is being refreshed. Try again shortly.",
        retryable: true,
      });
    }
    assertRequiredScopes(result.data.granted_scopes, input.requiredScopes);
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
  dispatchMode?: "read" | "side_effect";
  onDispatch?: () => void;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) {
    throw new ConnectorError({
      category: "timeout",
      code: "GOOGLE_REQUEST_CANCELLED",
      message: "The Google request was cancelled before dispatch.",
      retryable: false,
    });
  }
  const accessToken = await getGoogleAccessToken(input);
  let serializedBody: string | undefined;
  if (input.body !== undefined) {
    try {
      serializedBody = JSON.stringify(input.body);
    } catch {
      throw new ConnectorError({
        category: "validation",
        code: "GOOGLE_REQUEST_SERIALIZATION_FAILED",
        message: "The Google request data could not be prepared.",
        retryable: false,
      });
    }
  }
  const dispatchMode = input.dispatchMode ?? ((!input.method || input.method === "GET") ? "read" : "side_effect");
  let response: Response;
  try {
    input.onDispatch?.();
    response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...input.headers,
      },
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
      cache: "no-store",
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS)])
        : AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    });
  } catch {
    if (dispatchMode === "read") {
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
