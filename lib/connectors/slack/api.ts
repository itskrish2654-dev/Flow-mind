import { readConnectionSecret } from "@/lib/connectors/connection-vault";
import { ConnectorError, classifyConnectorHttpFailure } from "@/lib/connectors/errors";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";

const SLACK_API_TIMEOUT_MS = 12_000;

export async function getSlackAccessToken(input: { userId: string; connectionId: string; requiredScopes: string[] }) {
  const admin = createAdminClient();
  const { data, error } = await admin.from("connector_connections")
    .select("id,status,provider_family,granted_scopes")
    .eq("id", input.connectionId).eq("user_id", input.userId).eq("provider_family", "slack").maybeSingle();
  if (error || !data || data.status !== "connected") {
    throw new ConnectorError({ category: "authentication", code: "SLACK_RECONNECT_REQUIRED", message: "Reconnect Slack to continue.", retryable: false });
  }
  const missing = input.requiredScopes.filter((scope) => !data.granted_scopes.includes(scope));
  if (missing.length) {
    throw new ConnectorError({ category: "authorization", code: "SLACK_ADDITIONAL_SCOPE_REQUIRED", message: "CrazyLoops needs additional Slack permission for this workflow.", retryable: false });
  }
  return readConnectionSecret({ userId: input.userId, connectionId: input.connectionId, credentialKey: "access_token" });
}

export async function slackApiFetch(input: { userId: string; connectionId: string; requiredScopes: string[]; method: string; body?: Record<string, unknown>; query?: URLSearchParams; write?: boolean }) {
  const token = await getSlackAccessToken(input);
  const url = new URL(`https://slack.com/api/${input.method}`);
  if (input.query) url.search = input.query.toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: input.body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(input.body ? { "content-type": "application/json; charset=utf-8" } : {}) },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorError(input.write
      ? { category: "ambiguous_acknowledgement", code: "SLACK_RESPONSE_UNKNOWN", message: "Slack did not return an acknowledgement; the message may have been sent.", retryable: false }
      : { category: "provider_unavailable", code: "SLACK_READ_TIMEOUT", message: "Slack did not respond in time.", retryable: true });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!response.ok || body.ok !== true) {
    const authFailure = ["invalid_auth", "token_revoked", "account_inactive", "not_authed"].includes(body.error ?? "");
    if (authFailure) {
      await createAdminClient().from("connector_connections").update({ status: "expired", last_error_category: "authentication", updated_at: new Date().toISOString() }).eq("id", input.connectionId).eq("user_id", input.userId);
      await captureOperationalEvent({ level: "warn", event: "slack_reconnect_required", userId: input.userId, status: "expired", errorCategory: "authentication" });
    }
    const details = response.status === 429
      ? classifyConnectorHttpFailure(429, response.headers.get("retry-after"))
      : authFailure
        ? { category: "authentication" as const, code: "SLACK_RECONNECT_REQUIRED", message: "Reconnect Slack to continue.", retryable: false }
        : { category: body.error === "missing_scope" ? "authorization" as const : "validation" as const, code: `SLACK_${String(body.error ?? "REJECTED").toUpperCase()}`, message: body.error === "not_in_channel" ? "Invite the CrazyLoops Slack app to that channel, then try again." : "Slack rejected this operation.", retryable: false };
    throw new ConnectorError(details);
  }
  return body;
}

export function slackApiErrorResult(error: unknown) {
  const details = error instanceof ConnectorError ? error.details : { category: "validation" as const, code: "SLACK_INPUT_INVALID", message: error instanceof Error ? error.message : "Slack input is invalid.", retryable: false };
  return { status: details.category === "ambiguous_acknowledgement" ? "ambiguous" as const : "failed" as const, acknowledged: false, externallyDelivered: false, output: {}, metadata: {}, error: details };
}
