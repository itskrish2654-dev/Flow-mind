import { googleApiErrorResult, googleApiFetch } from "@/lib/connectors/google/api";
import { ConnectorError } from "@/lib/connectors/errors";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { assertSelectedGoogleSpreadsheet } from "@/lib/connectors/google/selected-spreadsheets";
import { readBoundedSheetJson, sheetResponseRows } from "@/lib/connectors/google/sheets-response";
import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { captureOperationalEvent } from "@/lib/observability";
import {
  acknowledgedSheetAppendRange, acknowledgedSheetCellRanges, boundedSheetCell, changedSheetCells, columnLetter, exactRowForHeaders, MAX_SHEET_COLUMNS,
  MAX_SHEET_READ_ROWS, hashSheetRow, normalizeSpreadsheetId,
  parseSheetHeaders, quoteSheetName, rowForHeaders, rowMatchesExpected, safeSheetValue,
} from "@/lib/connectors/google/sheets-values";
export { normalizeSpreadsheetId, safeSheetValue } from "@/lib/connectors/google/sheets-values";

const MAX_EXACT_LOOKUP_ROWS = 1_000;
const MAX_SHEET_METADATA_BYTES = 64 * 1024;
const MAX_SHEET_ROWS_BYTES = 512 * 1024;
const MAX_WORKSHEETS = 50;

function validationFailure(error: unknown) {
  return error instanceof ConnectorError ? error : new ConnectorError({
    category: "validation", code: "SHEETS_INPUT_INVALID",
    message: error instanceof Error ? error.message : "The Google Sheets request is invalid.",
    retryable: false,
  });
}

async function recordSheetFailure(error: unknown, context: Parameters<ConnectorActionHandler>[1], operation: string) {
  const rateLimited = error instanceof ConnectorError && error.details.category === "rate_limit";
  await captureOperationalEvent({ level: "warn", event: rateLimited ? "sheets_rate_limited" : "sheets_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: rateLimited ? "rate_limit" : "provider", metadata: { operation } });
}

function valuesObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mapped sheet values are required.");
  return value as Record<string, unknown>;
}

async function sheetContext(input: { userId: string; workspaceId?: string; connectionId: string; spreadsheetId: unknown; worksheet: unknown }) {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId); const sheetName = String(input.worksheet ?? "").trim();
  const selected = await assertSelectedGoogleSpreadsheet({ userId: input.userId, workspaceId: input.workspaceId, connectionId: input.connectionId, spreadsheetId });
  const metadataResponse = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(title,gridProperties(rowCount,columnCount))` });
  const metadata = await readBoundedSheetJson(metadataResponse, MAX_SHEET_METADATA_BYTES) as { sheets?: Array<{ properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }> };
  if (!Array.isArray(metadata.sheets) || metadata.sheets.length > MAX_WORKSHEETS) {
    throw new Error("This spreadsheet has too many worksheets or its metadata is unavailable.");
  }
  const worksheet = metadata.sheets?.find((item) => item.properties?.title === sheetName)?.properties;
  if (!worksheet) throw new Error("The selected worksheet is unavailable.");
  const rowCount = worksheet.gridProperties?.rowCount;
  const columnCount = worksheet.gridProperties?.columnCount;
  if (!Number.isInteger(rowCount) || !Number.isInteger(columnCount) || !rowCount || !columnCount || columnCount > MAX_SHEET_COLUMNS) {
    throw new Error("This worksheet is too large or its dimensions are unavailable; choose a worksheet with at most 32 columns.");
  }
  const range = `${quoteSheetName(sheetName)}!A1:${columnLetter(columnCount - 1)}1`;
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS` });
  const data = await readBoundedSheetJson(response, MAX_SHEET_METADATA_BYTES);
  const headers = parseSheetHeaders(sheetResponseRows(data.values, 1)[0] ?? []);
  return { spreadsheetId, sheetName, headers, rowCount, selectedName: selected.display_name };
}

export async function inspectSelectedGoogleWorksheet(input: {
  userId: string; workspaceId: string; connectionId: string; spreadsheetId: string; worksheet: string;
}) {
  return sheetContext(input);
}

export async function readSelectedGoogleSpreadsheetRow(input: {
  userId: string; workspaceId: string; connectionId: string; spreadsheetId: string;
  worksheet: string; rowNumber: number;
}) {
  const sheet = await sheetContext(input);
  if (!Number.isInteger(input.rowNumber) || input.rowNumber < 2 || input.rowNumber > sheet.rowCount) {
    throw new Error("Choose an existing data row.");
  }
  const range = `${quoteSheetName(sheet.sheetName)}!A${input.rowNumber}:${columnLetter(sheet.headers.length - 1)}${input.rowNumber}`;
  const response = await googleApiFetch({
    userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile],
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
  });
  const data = await readBoundedSheetJson(response, MAX_SHEET_METADATA_BYTES);
  const current = sheetResponseRows(data.values, 1)[0] ?? [];
  if (!current.some((value) => value !== null && value !== undefined && value !== "")) {
    throw new Error("The selected row is empty.");
  }
  return { ...sheet, rowNumber: input.rowNumber,
    values: Object.fromEntries(sheet.headers.map((header, index) => [header, safeSheetValue(current[index])])),
    rowHash: hashSheetRow(sheet.headers, current) };
}

/** Exact lookup refuses incomplete scans and never chooses the first duplicate. */
export async function findSelectedGoogleSpreadsheetRow(input: {
  userId: string; workspaceId?: string; connectionId: string; spreadsheetId: string;
  worksheet: string; matchColumn: string; matchValue: string;
}) {
  const sheet = await sheetContext(input);
  const columnIndex = sheet.headers.findIndex((header) => header.toLowerCase() === input.matchColumn.trim().toLowerCase());
  if (columnIndex < 0) throw new Error("The lookup column does not exist in the selected worksheet.");
  if (sheet.rowCount < 2) return { ...sheet, found: false as const, multipleMatches: false, matchCount: 0, rowNumber: null, values: {} };
  if (sheet.rowCount - 1 > MAX_EXACT_LOOKUP_ROWS) throw new Error("This worksheet is too large for an exact unique lookup. Narrow the sheet before using this action.");
  const range = `${quoteSheetName(sheet.sheetName)}!${columnLetter(columnIndex)}2:${columnLetter(columnIndex)}${sheet.rowCount}`;
  const response = await googleApiFetch({
    userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile],
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
  });
  const data = await readBoundedSheetJson(response, MAX_SHEET_ROWS_BYTES);
  const matches = sheetResponseRows(data.values, MAX_EXACT_LOOKUP_ROWS).flatMap((row, index) =>
    String(row[0] ?? "") === input.matchValue ? [index + 2] : []);
  if (matches.length !== 1) return { ...sheet, found: false as const, multipleMatches: matches.length > 1, matchCount: matches.length, rowNumber: null, values: {} };
  const rowNumber = matches[0];
  const rowRange = `${quoteSheetName(sheet.sheetName)}!A${rowNumber}:${columnLetter(sheet.headers.length - 1)}${rowNumber}`;
  const rowResponse = await googleApiFetch({
    userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile],
    url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(rowRange)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
  });
  const rowData = await readBoundedSheetJson(rowResponse, MAX_SHEET_METADATA_BYTES);
  const row = sheetResponseRows(rowData.values, 1)[0] ?? [];
  if (String(row[columnIndex] ?? "") !== input.matchValue) {
    throw new Error("The matching row changed during lookup. Try again before using it.");
  }
  return { ...sheet, found: true as const, multipleMatches: false, matchCount: 1, rowNumber,
    values: Object.fromEntries(sheet.headers.map((header, index) => [header, safeSheetValue(row[index])])) };
}

export async function inspectGoogleSpreadsheet(input: { userId: string; workspaceId?: string; connectionId: string; spreadsheetId: string }) {
  const spreadsheetId = normalizeSpreadsheetId(input.spreadsheetId);
  await assertSelectedGoogleSpreadsheet({ userId: input.userId, workspaceId: input.workspaceId, connectionId: input.connectionId, spreadsheetId });
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,properties.title,sheets.properties` });
  const data = await readBoundedSheetJson(response, MAX_SHEET_METADATA_BYTES) as { properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string; sheetId?: number } }> };
  if (!Array.isArray(data.sheets) || data.sheets.length > MAX_WORKSHEETS) {
    throw new Error("This spreadsheet has too many worksheets or its metadata is unavailable.");
  }
  return { spreadsheetId, title: data.properties?.title ?? "Google spreadsheet", worksheets: (data.sheets ?? []).flatMap((sheet) => sheet.properties?.title ? [{ id: sheet.properties.sheetId ?? 0, title: sheet.properties.title }] : []) };
}

/** Server-owned bounded read. An omitted row is never represented as a complete-sheet result. */
export async function readSelectedGoogleSpreadsheetRows(input: {
  userId: string; workspaceId: string; connectionId: string; spreadsheetId: string;
  worksheet: string; startRow?: number; limit?: number;
}) {
  const sheet = await sheetContext(input);
  const startRow = input.startRow ?? 2;
  const limit = input.limit ?? MAX_SHEET_READ_ROWS;
  if (!Number.isInteger(startRow) || startRow < 2 || !Number.isInteger(limit) || limit < 1 || limit > MAX_SHEET_READ_ROWS) {
    throw new Error("The requested worksheet page is invalid.");
  }
  const lastRow = Math.min(sheet.rowCount, startRow + limit - 1);
  const range = `${quoteSheetName(sheet.sheetName)}!A${startRow}:${columnLetter(sheet.headers.length - 1)}${lastRow}`;
  if (startRow > sheet.rowCount) return { ...sheet, rows: [], range, hasMore: false, startRow, limit };
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE` });
  const data = await readBoundedSheetJson(response, MAX_SHEET_ROWS_BYTES);
  const rows = sheetResponseRows(data.values, limit).map((row, index) => ({
    rowNumber: startRow + index,
    cells: Object.fromEntries(sheet.headers.map((header, column) => [header, boundedSheetCell(row[column])])),
  }));
  return { ...sheet, rows, range, hasMore: lastRow < sheet.rowCount, startRow, limit };
}

export const sheetsAddRow: ConnectorActionHandler = async (input, context) => {
  let dispatched = false;
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before adding a row.");
    const sheet = await sheetContext({ userId: context.userId, connectionId: context.connectionId, spreadsheetId: input.spreadsheetId, worksheet: input.worksheet });
    const row = input.strictColumns === true
      ? exactRowForHeaders(sheet.headers, valuesObject(input.values))
      : rowForHeaders(sheet.headers, valuesObject(input.values));
    const target = `${quoteSheetName(sheet.sheetName)}!A:A`;
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(target)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, method: "POST", body: { majorDimension: "ROWS", values: [row] }, onDispatch: () => { dispatched = true; }, signal: context.signal });
    const result = await readBoundedSheetJson(response, MAX_SHEET_METADATA_BYTES);
    const updatedRange = acknowledgedSheetAppendRange(result);
    if (!updatedRange) throw new Error("Google Sheets did not acknowledge exactly one inserted row.");
    await captureOperationalEvent({ level: "info", event: "sheets_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "add_row" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: updatedRange, output: { updatedRange, updatedRows: 1 }, metadata: { operation: "add_row" } };
  } catch (error) {
    await recordSheetFailure(error, context, "add_row");
    return googleApiErrorResult(dispatched ? error : validationFailure(error));
  }
};

export const sheetsFindRow: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before finding a row.");
    const result = await findSelectedGoogleSpreadsheetRow({
      userId: context.userId, connectionId: context.connectionId,
      spreadsheetId: String(input.spreadsheetId ?? ""), worksheet: String(input.worksheet ?? ""),
      matchColumn: String(input.matchColumn ?? ""), matchValue: String(input.matchValue ?? ""),
    });
    if (result.multipleMatches) {
      await captureOperationalEvent({ level: "warn", event: "sheets_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: "validation", metadata: { operation: "find_row", matchCount: result.matchCount } });
      return { status: "failed", acknowledged: true, externallyDelivered: false, output: { found: false, multipleMatches: true, matchCount: result.matchCount }, metadata: { operation: "find_row", matchCount: result.matchCount }, error: { category: "validation", code: "SHEETS_AMBIGUOUS_MATCH", message: "More than one Google Sheets row matched; choose a unique key.", retryable: false } };
    }
    await captureOperationalEvent({ level: "info", event: "sheets_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "find_row", matchCount: result.matchCount } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: false, ...(result.rowNumber ? { providerReferenceId: `${result.sheetName}:${result.rowNumber}` } : {}), output: { found: result.found, rowNumber: result.rowNumber, values: result.values }, metadata: { operation: "find_row", matchCount: result.matchCount } };
  } catch (error) { await recordSheetFailure(error, context, "find_row"); return googleApiErrorResult(validationFailure(error)); }
};

export const sheetsUpdateRow: ConnectorActionHandler = async (input, context) => {
  let dispatched = false;
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before updating a row.");
    const rowNumber = Number(input.rowNumber); if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error("A deterministic data row number is required.");
    const sheet = await sheetContext({ userId: context.userId, connectionId: context.connectionId, spreadsheetId: input.spreadsheetId, worksheet: input.worksheet });
    if (rowNumber > sheet.rowCount) throw new Error("The selected row is outside the worksheet.");
    const range = `${quoteSheetName(sheet.sheetName)}!A${rowNumber}:${columnLetter(sheet.headers.length - 1)}${rowNumber}`;
    const currentResponse = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`, signal: context.signal });
    const currentData = await readBoundedSheetJson(currentResponse, MAX_SHEET_METADATA_BYTES);
    const current = sheetResponseRows(currentData.values, 1)[0] ?? [];
    if (typeof input.expectedRowHash === "string" &&
      (!/^[a-f0-9]{64}$/.test(input.expectedRowHash) ||
        hashSheetRow(sheet.headers, current) !== input.expectedRowHash)) {
      throw new Error("The selected row changed since preview. Review it again before approving an update.");
    }
    if (input.expectedRowValues !== undefined && !rowMatchesExpected(sheet.headers, current, valuesObject(input.expectedRowValues))) {
      throw new Error("The selected row changed since preview. Review it again before approving an update.");
    }
    const changed = changedSheetCells(sheet.headers, current, valuesObject(input.values), input.strictColumns === true);
    if (!changed.length) throw new Error("The requested values already match the selected row; nothing was changed.");
    const data = changed.map(({ column, value }) => ({
      range: `${quoteSheetName(sheet.sheetName)}!${column}${rowNumber}`,
      majorDimension: "ROWS" as const,
      values: [[value]],
    }));
    // A single provider request changes only explicitly different cells. Untouched
    // formulas, dates, and formatting-sensitive values are never rewritten.
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.driveFile], url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheet.spreadsheetId)}/values:batchUpdate`, method: "POST", body: { valueInputOption: "RAW", data }, onDispatch: () => { dispatched = true; }, signal: context.signal });
    const result = await readBoundedSheetJson(response, MAX_SHEET_METADATA_BYTES);
    const acknowledgedRanges = acknowledgedSheetCellRanges(result, sheet.spreadsheetId, rowNumber,
      changed.map((item) => item.column));
    if (!acknowledgedRanges) {
      throw new Error("Google Sheets did not acknowledge the exact changed cells.");
    }
    const updatedRange = acknowledgedRanges.join(", ");
    await captureOperationalEvent({ level: "info", event: "sheets_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "update_row" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: updatedRange, output: { updatedRange, updatedRows: 1 }, metadata: { operation: "update_row", changedCells: changed.length } };
  } catch (error) { await recordSheetFailure(error, context, "update_row"); return googleApiErrorResult(dispatched ? error : validationFailure(error)); }
};
