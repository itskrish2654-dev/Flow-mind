import { googleApiErrorResult, googleApiFetch } from "@/lib/connectors/google/api";
import { ConnectorError } from "@/lib/connectors/errors";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { captureOperationalEvent } from "@/lib/observability";
import { normalizeSpreadsheetId, quoteSheetName, rowForHeaders, safeSheetValue } from "@/lib/connectors/google/sheets-values";
export { normalizeSpreadsheetId, safeSheetValue } from "@/lib/connectors/google/sheets-values";

async function recordSheetFailure(error: unknown, context: Parameters<ConnectorActionHandler>[1], operation: string) {
  const rateLimited = error instanceof ConnectorError && error.details.category === "rate_limit";
  await captureOperationalEvent({ level: "warn", event: rateLimited ? "sheets_rate_limited" : "sheets_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: rateLimited ? "rate_limit" : "provider", metadata: { operation } });
}

function valuesObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mapped sheet values are required.");
  return value as Record<string, unknown>;
}

async function sheetContext(input: { userId: string; connectionId: string; spreadsheetId: unknown; worksheet: unknown }) {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId); const sheetName = String(input.worksheet ?? "").trim();
  const range = `${quoteSheetName(sheetName)}!1:1`;
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.sheets], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS` });
  const data = await response.json() as { values?: unknown[][] };
  const headers = (data.values?.[0] ?? []).map((value) => String(value).trim()).filter(Boolean).slice(0, 200);
  if (!headers.length) throw new Error("The selected worksheet needs a header row.");
  if (new Set(headers).size !== headers.length) throw new Error("The selected worksheet has duplicate header names.");
  return { spreadsheetId, sheetName, headers };
}

export async function inspectGoogleSpreadsheet(input: { userId: string; connectionId: string; spreadsheetId: string }) {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId);
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.sheets], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties` });
  const data = await response.json() as { properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> };
  return { spreadsheetId, title: data.properties?.title ?? "Google spreadsheet", worksheets: (data.sheets ?? []).flatMap((sheet) => sheet.properties?.title ? [{ id: sheet.properties.sheetId ?? 0, title: sheet.properties.title }] : []) };
}

export const sheetsAddRow: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before adding a row.");
    const sheet = await sheetContext({ userId: context.userId, connectionId: context.connectionId, spreadsheetId: input.spreadsheetId, worksheet: input.worksheet });
    const row = rowForHeaders(sheet.headers, valuesObject(input.values));
    const target = `${quoteSheetName(sheet.sheetName)}!A:A`;
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.sheets], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(target)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, method: "POST", body: { majorDimension: "ROWS", values: [row] } });
    const result = await response.json() as { updates?: { updatedRange?: string; updatedRows?: number } };
    if (!result.updates?.updatedRange || result.updates.updatedRows !== 1) throw new Error("Google Sheets did not acknowledge exactly one inserted row.");
    await captureOperationalEvent({ level: "info", event: "sheets_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "add_row" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: result.updates.updatedRange, output: { updatedRange: result.updates.updatedRange, updatedRows: 1 }, metadata: { operation: "add_row" } };
  } catch (error) {
    await recordSheetFailure(error, context, "add_row");
    return googleApiErrorResult(error);
  }
};

export const sheetsFindRow: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before finding a row.");
    const sheet = await sheetContext({ userId: context.userId, connectionId: context.connectionId, spreadsheetId: input.spreadsheetId, worksheet: input.worksheet });
    const column = String(input.matchColumn ?? "").trim(); const columnIndex = sheet.headers.indexOf(column);
    if (columnIndex < 0) throw new Error("The lookup column does not exist in the selected worksheet.");
    const range = `${quoteSheetName(sheet.sheetName)}!A2:ZZ`;
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.sheets], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE` });
    const data = await response.json() as { values?: unknown[][] }; const expected = String(input.matchValue ?? "");
    const matches = (data.values ?? []).map((row, index) => ({ row, rowNumber: index + 2 })).filter(({ row }) => String(row[columnIndex] ?? "") === expected);
    if (matches.length > 1) {
      await captureOperationalEvent({ level: "warn", event: "sheets_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: "validation", metadata: { operation: "find_row", matchCount: matches.length } });
      return { status: "failed", acknowledged: true, externallyDelivered: false, output: { found: false, multipleMatches: true, matchCount: matches.length }, metadata: { operation: "find_row", matchCount: matches.length }, error: { category: "validation", code: "SHEETS_AMBIGUOUS_MATCH", message: "More than one Google Sheets row matched; choose a unique key.", retryable: false } };
    }
    const match = matches[0]; const values = match ? Object.fromEntries(sheet.headers.map((header, index) => [header, safeSheetValue(match.row[index])])) : {};
    await captureOperationalEvent({ level: "info", event: "sheets_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "find_row", matchCount: matches.length } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: false, ...(match ? { providerReferenceId: `${sheet.sheetName}:${match.rowNumber}` } : {}), output: { found: Boolean(match), rowNumber: match?.rowNumber ?? null, values }, metadata: { operation: "find_row", matchCount: matches.length } };
  } catch (error) { await recordSheetFailure(error, context, "find_row"); return googleApiErrorResult(error); }
};

export const sheetsUpdateRow: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before updating a row.");
    const rowNumber = Number(input.rowNumber); if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error("A deterministic data row number is required.");
    const sheet = await sheetContext({ userId: context.userId, connectionId: context.connectionId, spreadsheetId: input.spreadsheetId, worksheet: input.worksheet });
    const row = rowForHeaders(sheet.headers, valuesObject(input.values)); const range = `${quoteSheetName(sheet.sheetName)}!A${rowNumber}`;
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.sheets], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, method: "PUT", body: { majorDimension: "ROWS", values: [row] } });
    const result = await response.json() as { updatedRange?: string; updatedRows?: number };
    if (!result.updatedRange || result.updatedRows !== 1) throw new Error("Google Sheets did not acknowledge exactly one updated row.");
    await captureOperationalEvent({ level: "info", event: "sheets_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "update_row" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: result.updatedRange, output: { updatedRange: result.updatedRange, updatedRows: 1 }, metadata: { operation: "update_row" } };
  } catch (error) { await recordSheetFailure(error, context, "update_row"); return googleApiErrorResult(error); }
};
