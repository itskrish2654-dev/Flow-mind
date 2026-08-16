import "server-only";

import { readConnectionSecret } from "@/lib/connectors/connection-vault";
import { ConnectorError } from "@/lib/connectors/errors";
import { stopGmailWatch } from "@/lib/connectors/google/gmail-push";
import { revokeGoogleToken } from "@/lib/connectors/google/oauth-provider";
import { GOOGLE_LEGACY_SHEETS_SCOPE, GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { normalizeSpreadsheetId } from "@/lib/connectors/google/sheets-values";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export const GOOGLE_SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";

function authorizationError(code: string, message: string) {
  return new ConnectorError({
    category: "authorization",
    code,
    message,
    retryable: false,
  });
}

function safeMetadata(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Json | undefined>
    : {};
}

export async function assertSelectedGoogleSpreadsheet(input: {
  userId: string;
  connectionId: string;
  spreadsheetId: unknown;
}) {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId);
  const { data, error } = await createAdminClient()
    .from("google_selected_spreadsheets")
    .select("spreadsheet_id,display_name")
    .eq("user_id", input.userId)
    .eq("connection_id", input.connectionId)
    .eq("spreadsheet_id", spreadsheetId)
    .maybeSingle();
  if (error || !data) {
    throw authorizationError(
      "GOOGLE_SHEET_NOT_PICKER_SELECTED",
      "Choose this spreadsheet through Google Picker before running the workflow.",
    );
  }
  return data;
}

export async function listSelectedGoogleSpreadsheets(input: {
  userId: string;
  connectionId: string;
}) {
  const { data, error } = await createAdminClient()
    .from("google_selected_spreadsheets")
    .select("spreadsheet_id,display_name,last_validated_at")
    .eq("user_id", input.userId)
    .eq("connection_id", input.connectionId)
    .order("selected_at", { ascending: false });
  if (error) throw new Error("Selected spreadsheets could not be loaded.");
  return (data ?? []).map((item) => ({
    id: item.spreadsheet_id,
    name: item.display_name,
    lastValidatedAt: item.last_validated_at,
  }));
}

export async function registerPickerSelectedSpreadsheet(input: {
  userId: string;
  connectionId: string;
  spreadsheetId: unknown;
  pickerAccessToken: string;
}) {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId);
  const accessToken = input.pickerAccessToken.trim();
  if (!accessToken || accessToken.length > 4_096) {
    throw authorizationError("GOOGLE_PICKER_TOKEN_INVALID", "Google Picker authorization is invalid.");
  }
  const expectedAudience = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!expectedAudience) throw new Error("Google OAuth client configuration is missing.");

  const tokenResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    { cache: "no-store", signal: AbortSignal.timeout(8_000) },
  );
  const token = await tokenResponse.json().catch(() => ({})) as {
    aud?: string;
    sub?: string;
    scope?: string;
    expires_in?: string;
  };
  const tokenScopes = new Set(token.scope?.split(/\s+/).filter(Boolean) ?? []);
  if (
    !tokenResponse.ok ||
    token.aud !== expectedAudience ||
    !token.sub ||
    !tokenScopes.has(GOOGLE_SCOPES.driveFile) ||
    tokenScopes.has(GOOGLE_LEGACY_SHEETS_SCOPE) ||
    Number(token.expires_in ?? 0) <= 0
  ) {
    throw authorizationError("GOOGLE_PICKER_TOKEN_INVALID", "Google Picker authorization could not be verified.");
  }

  const admin = createAdminClient();
  const { data: connection } = await admin
    .from("connector_connections")
    .select("id,external_account_id,status,granted_scopes")
    .eq("id", input.connectionId)
    .eq("user_id", input.userId)
    .eq("provider_family", "google")
    .maybeSingle();
  if (
    !connection ||
    connection.status !== "connected" ||
    connection.external_account_id !== token.sub ||
    !connection.granted_scopes.includes(GOOGLE_SCOPES.driveFile) ||
    connection.granted_scopes.includes(GOOGLE_LEGACY_SHEETS_SCOPE)
  ) {
    throw authorizationError("GOOGLE_RECONNECT_REQUIRED", "Reconnect the selected Google account to continue.");
  }

  const fileResponse = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=id,name,mimeType,trashed`,
    {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    },
  );
  const file = await fileResponse.json().catch(() => ({})) as {
    id?: string;
    name?: string;
    mimeType?: string;
    trashed?: boolean;
  };
  if (
    !fileResponse.ok ||
    file.id !== spreadsheetId ||
    file.mimeType !== GOOGLE_SPREADSHEET_MIME_TYPE ||
    file.trashed === true ||
    !file.name?.trim()
  ) {
    throw authorizationError("GOOGLE_PICKER_FILE_INVALID", "The selected file is not an accessible Google spreadsheet.");
  }

  const now = new Date().toISOString();
  const { error } = await admin.from("google_selected_spreadsheets").upsert({
    user_id: input.userId,
    connection_id: input.connectionId,
    spreadsheet_id: spreadsheetId,
    display_name: file.name.trim().slice(0, 255),
    mime_type: GOOGLE_SPREADSHEET_MIME_TYPE,
    selected_at: now,
    last_validated_at: now,
  }, { onConflict: "connection_id,spreadsheet_id" });
  if (error) throw new Error("The selected spreadsheet could not be saved.");
  return { id: spreadsheetId, name: file.name.trim().slice(0, 255) };
}

async function optionalConnectionSecret(userId: string, connectionId: string, credentialKey: string) {
  try {
    return await readConnectionSecret({ userId, connectionId, credentialKey });
  } catch {
    return null;
  }
}

export async function prepareGoogleConnectionForDriveFileReconnect(input: {
  userId: string;
  connectionId: string;
}) {
  const admin = createAdminClient();
  const { data: connection } = await admin.from("connector_connections")
    .select("id,safe_metadata,granted_scopes,status")
    .eq("id", input.connectionId)
    .eq("user_id", input.userId)
    .eq("provider_family", "google")
    .maybeSingle();
  if (!connection) throw new Error("Connection not found.");
  const metadata = safeMetadata(connection.safe_metadata);
  const migrationRequired = metadata.drive_file_reconnect_required === true ||
    connection.granted_scopes.includes(GOOGLE_LEGACY_SHEETS_SCOPE);
  if (!migrationRequired) return;

  try {
    await stopGmailWatch({ userId: input.userId, connectionId: input.connectionId });
  } catch {
    // The old grant can already be expired. Remote revocation below remains the
    // authoritative requirement before any new authorization is issued.
  }
  const refreshToken = await optionalConnectionSecret(input.userId, input.connectionId, "refresh_token");
  const accessToken = refreshToken
    ? null
    : await optionalConnectionSecret(input.userId, input.connectionId, "access_token");
  const token = refreshToken ?? accessToken;
  if (token && !(await revokeGoogleToken(token))) {
    throw new Error("The previous Google permission could not be revoked safely.");
  }

  await Promise.all([
    admin.from("connector_connection_credentials").delete()
      .eq("connection_id", input.connectionId).eq("user_id", input.userId),
    admin.from("google_selected_spreadsheets").delete()
      .eq("connection_id", input.connectionId).eq("user_id", input.userId),
    admin.from("connector_subscriptions").update({ status: "paused", updated_at: new Date().toISOString() })
      .eq("connection_id", input.connectionId).eq("user_id", input.userId).eq("status", "active"),
  ]);
  const { error } = await admin.from("connector_connections").update({
    status: "expired",
    granted_scopes: [],
    token_expires_at: null,
    last_error_category: "authorization",
    safe_metadata: {
      ...metadata,
      drive_file_reconnect_required: false,
      drive_file_reconnect_started: true,
    } as Json,
    updated_at: new Date().toISOString(),
  }).eq("id", input.connectionId).eq("user_id", input.userId);
  if (error) throw new Error("The Google connection could not be prepared for reconnect.");
}
