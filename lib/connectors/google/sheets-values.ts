import { createHash } from "node:crypto";

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;
export const MAX_SHEET_COLUMNS = 32;
export const MAX_SHEET_READ_ROWS = 50;
export const MAX_SHEET_CELL_CHARACTERS = 300;

export function normalizeSpreadsheetId(value: unknown) {
  const text = String(value ?? "").trim();
  if (!SPREADSHEET_ID.test(text)) throw new Error("Choose a spreadsheet through Google Picker.");
  return text;
}

export function quoteSheetName(value: unknown) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 100) throw new Error("Choose a valid worksheet.");
  return `'${name.replace(/'/g, "''")}'`;
}

export function safeSheetValue(value: unknown): string | number | boolean {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Sheet numbers must be finite.");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.slice(0, 50_000);
  return JSON.stringify(value).slice(0, 50_000);
}

export function columnLetter(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SHEET_COLUMNS) throw new Error("The worksheet has too many columns.");
  let value = index + 1;
  let letter = "";
  while (value > 0) {
    value -= 1;
    letter = String.fromCharCode(65 + value % 26) + letter;
    value = Math.floor(value / 26);
  }
  return letter;
}

export function parseSheetHeaders(values: unknown[]) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("The selected worksheet needs a header row.");
  if (values.length > MAX_SHEET_COLUMNS) throw new Error("The worksheet has too many columns for a safe read.");
  const headers = values.map((value) => String(value ?? "").trim());
  if (headers.some((header) => !header || header.length > 100)) {
    throw new Error("Every used worksheet column needs a short, non-empty header.");
  }
  if (new Set(headers.map((header) => header.toLowerCase())).size !== headers.length) {
    throw new Error("The selected worksheet has duplicate header names.");
  }
  return headers;
}

function flattenedSheetValues(values: Record<string, unknown>) {
  const flattened: Record<string, unknown> = {};
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > 4 || !value || typeof value !== "object" || Array.isArray(value)) {
      if (path) flattened[path] = value;
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const nested = path ? `${path}.${key}` : key;
      visit(child, nested, depth + 1);
      if (!(key in flattened) && (!child || typeof child !== "object" || Array.isArray(child))) flattened[key] = child;
    }
  };
  visit(values, "", 0);
  const message = values.message && typeof values.message === "object" && !Array.isArray(values.message)
    ? values.message as Record<string, unknown>
    : null;
  if (message) {
    const from = String(message.from ?? "");
    const address = from.match(/<([^>]+)>/)?.[1] ?? from;
    const name = from.replace(/<[^>]+>/, "").replace(/^"|"$/g, "").trim();
    flattened.email ??= address;
    flattened.senderEmail ??= address;
    if (name) {
      flattened.name ??= name;
      flattened.senderName ??= name;
    }
    flattened.body ??= message.text;
    flattened.messageText ??= message.text;
  }
  return flattened;
}

export function rowForHeaders(headers: string[], values: Record<string, unknown>) {
  const flattened = flattenedSheetValues(values);
  const exact = new Map(Object.entries(flattened));
  const insensitive = new Map(Object.entries(flattened).map(([key, value]) => [key.toLowerCase(), value]));
  // Extra source fields are intentionally ignored. CrazyLoops never creates sheet
  // columns implicitly; only real header names become write targets.
  return headers.map((header) => safeSheetValue(exact.get(header) ?? insensitive.get(header.toLowerCase())));
}

export function exactRowForHeaders(headers: string[], values: Record<string, unknown>) {
  const byHeader = new Map(headers.map((header) => [header.toLowerCase(), header]));
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const header = byHeader.get(key.trim().toLowerCase());
    if (!header || Object.hasOwn(normalized, header)) {
      throw new Error(`The requested column “${key.slice(0, 100)}” is not a unique existing header.`);
    }
    normalized[header] = value;
  }
  if (Object.keys(normalized).length === 0) throw new Error("At least one existing column value is required.");
  return headers.map((header) => safeSheetValue(normalized[header]));
}

export function mergeRowForHeaders(headers: string[], current: unknown[], values: Record<string, unknown>, strict = false) {
  const flattened = strict ? values : flattenedSheetValues(values);
  const byHeader = new Map(headers.map((header, index) => [header.toLowerCase(), index]));
  const next = headers.map((_, index) => safeSheetValue(current[index]));
  let updated = 0;
  for (const [key, value] of Object.entries(flattened)) {
    const index = byHeader.get(key.trim().toLowerCase());
    if (index === undefined) {
      if (strict) throw new Error(`The requested column “${key.slice(0, 100)}” is not an existing header.`);
      continue;
    }
    next[index] = safeSheetValue(value);
    updated += 1;
  }
  if (updated === 0) throw new Error("No existing worksheet columns were provided for update.");
  return next;
}

/** Only changed cells may be sent to Google; rewriting a full row would destroy untouched formulas. */
export function changedSheetCells(headers: string[], current: unknown[], values: Record<string, unknown>, strict = false) {
  const next = mergeRowForHeaders(headers, current, values, strict);
  return next.flatMap((value, index) => Object.is(value, safeSheetValue(current[index]))
    ? [] : [{ column: columnLetter(index), value }]);
}

export function acknowledgedSheetCellRanges(
  result: unknown,
  spreadsheetId: string,
  rowNumber: number,
  columns: string[],
): string[] | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const data = result as Record<string, unknown>;
  // Google's aggregate row count may sum the individual ValueRanges. Each
  // response below is still required to acknowledge exactly the frozen row.
  if (data.spreadsheetId !== spreadsheetId || !Number.isInteger(data.totalUpdatedRows) ||
    (data.totalUpdatedRows as number) < 1 || (data.totalUpdatedRows as number) > columns.length ||
    data.totalUpdatedCells !== columns.length || !Array.isArray(data.responses) ||
    data.responses.length !== columns.length) return null;
  const ranges: string[] = [];
  for (const [index, column] of columns.entries()) {
    const response = data.responses[index];
    if (!response || typeof response !== "object" || Array.isArray(response)) return null;
    const item = response as Record<string, unknown>;
    if (item.updatedRows !== 1 || item.updatedCells !== 1 || typeof item.updatedRange !== "string" ||
      !new RegExp(`!${column}${rowNumber}(?::${column}${rowNumber})?$`).test(item.updatedRange)) return null;
    ranges.push(item.updatedRange);
  }
  return ranges;
}

export function acknowledgedSheetAppendRange(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const updates = (result as Record<string, unknown>).updates;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) return null;
  const { updatedRange, updatedRows } = updates as Record<string, unknown>;
  if (updatedRows !== 1 || typeof updatedRange !== "string" || updatedRange.length > 300) return null;
  const match = updatedRange.match(/!A(\d+)(?::([A-Z]{1,2})(\d+))?$/);
  if (!match || Number(match[1]) < 2 || (match[3] && match[3] !== match[1])) return null;
  if (match[2] && !Array.from({ length: MAX_SHEET_COLUMNS }, (_, index) => columnLetter(index)).includes(match[2])) return null;
  return updatedRange;
}

export function rowMatchesExpected(headers: string[], current: unknown[], expected: Record<string, unknown>) {
  if (Object.keys(expected).length !== headers.length) return false;
  return headers.every((header, index) =>
    Object.hasOwn(expected, header) &&
    Object.is(safeSheetValue(current[index]), safeSheetValue(expected[header])));
}

export function hashSheetRow(headers: string[], current: unknown[]) {
  return createHash("sha256").update(JSON.stringify(headers.map((header, index) => [header, safeSheetValue(current[index])]))).digest("hex");
}

export function boundedSheetCell(value: unknown) {
  const normalized = safeSheetValue(value);
  const text = String(normalized);
  return {
    value: text.slice(0, MAX_SHEET_CELL_CHARACTERS),
    truncated: text.length > MAX_SHEET_CELL_CHARACTERS,
  };
}
