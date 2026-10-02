/** Limit provider JSON before parsing so a huge or malformed worksheet cannot exhaust a server request. */
export async function readBoundedSheetJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid Google Sheets response limit.");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("The Google Sheets response exceeds the safe read limit.");
  if (!response.body) throw new Error("Google Sheets returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("The Google Sheets response exceeds the safe read limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Google Sheets returned an invalid response.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google Sheets returned an invalid response.");
  }
  return parsed as Record<string, unknown>;
}

export function sheetResponseRows(value: unknown, maxRows: number): unknown[][] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxRows || value.some((row) => !Array.isArray(row))) {
    throw new Error("Google Sheets returned invalid or excessive row data.");
  }
  return value as unknown[][];
}
