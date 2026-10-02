import "server-only";

import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { inspectGoogleSpreadsheet } from "@/lib/connectors/google/sheets";
import { listSelectedGoogleSpreadsheets } from "@/lib/connectors/google/selected-spreadsheets";
import { createAdminClient } from "@/lib/supabase/admin";

export type SelectedSheetContext = {
  connectionId: string;
  spreadsheetId: string;
  spreadsheetName: string;
  worksheet: string;
};

export type SelectedSheetResolution =
  | { status: "ok"; selection: SelectedSheetContext }
  | { status: "connection_required" | "reconnect_required" | "selection_required"; message: string };

function mentioned(question: string, label: string) {
  return label.length >= 2 && question.toLocaleLowerCase().includes(label.toLocaleLowerCase());
}

/** Resolves only server-owned Picker selections; the model supplies no file identifier. */
export async function resolveSelectedSheetForQuestion(input: {
  userId: string; workspaceId: string; question: string;
}): Promise<SelectedSheetResolution> {
  const { data: connections, error } = await createAdminClient().from("connector_connections")
    .select("id,status,granted_scopes,external_account_label")
    .eq("user_id", input.userId).eq("workspace_id", input.workspaceId)
    .eq("provider_family", "google").neq("status", "revoked")
    .order("created_at", { ascending: false }).limit(6);
  if (error) throw new Error("Google Sheets connections could not be checked.");
  if (!connections?.length) return { status: "connection_required", message: "Connect Google Sheets before using a spreadsheet." };
  const usable = connections.filter((connection) => connection.status === "connected"
    && connection.granted_scopes.includes(GOOGLE_SCOPES.driveFile));
  if (!usable.length) return { status: "reconnect_required", message: "Reconnect Google Sheets with per-file access." };
  const candidates = await Promise.all(usable.map(async (connection) => ({
    connection,
    sheets: await listSelectedGoogleSpreadsheets({
      userId: input.userId, workspaceId: input.workspaceId, connectionId: connection.id,
    }),
  })));
  const selected = candidates.flatMap(({ connection, sheets }) => sheets.map((sheet) => ({ connection, sheet })));
  if (!selected.length) return { status: "selection_required", message: "Choose a spreadsheet through Google Picker in Connections first." };
  const explicitlyNamed = selected.filter(({ connection, sheet }) =>
    mentioned(input.question, sheet.name) || (connection.external_account_label &&
      mentioned(input.question, connection.external_account_label)));
  const matches = explicitlyNamed.length ? explicitlyNamed : selected.length === 1 ? selected : [];
  if (matches.length !== 1) {
    return { status: "selection_required", message: "Which Picker-selected spreadsheet and Google account should CrazyLoops use? Name the spreadsheet in your request." };
  }
  const { connection, sheet } = matches[0];
  const metadata = await inspectGoogleSpreadsheet({
    userId: input.userId, workspaceId: input.workspaceId,
    connectionId: connection.id, spreadsheetId: sheet.id,
  });
  const explicitWorksheets = metadata.worksheets.filter((worksheet) => mentioned(input.question, worksheet.title));
  const worksheet = explicitWorksheets.length === 1 ? explicitWorksheets[0]
    : metadata.worksheets.length === 1 ? metadata.worksheets[0] : null;
  if (!worksheet) return {
    status: "selection_required",
    message: "Which worksheet should CrazyLoops use? Include its exact worksheet name in your request.",
  };
  return { status: "ok", selection: {
    connectionId: connection.id, spreadsheetId: sheet.id,
    spreadsheetName: sheet.name, worksheet: worksheet.title,
  } };
}
