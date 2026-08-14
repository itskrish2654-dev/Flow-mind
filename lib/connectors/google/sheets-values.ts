const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

export function normalizeSpreadsheetId(value: unknown) {
  const text = String(value ?? "").trim();
  const fromUrl = text.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1];
  const id = fromUrl ?? text;
  if (!SPREADSHEET_ID.test(id)) throw new Error("Choose a valid Google spreadsheet.");
  return id;
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

export function rowForHeaders(headers: string[], values: Record<string, unknown>) {
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
  const exact = new Map(Object.entries(flattened));
  const insensitive = new Map(Object.entries(flattened).map(([key, value]) => [key.toLowerCase(), value]));
  // Extra source fields are intentionally ignored. CrazyLoops never creates sheet
  // columns implicitly; only real header names become write targets.
  return headers.map((header) => safeSheetValue(exact.get(header) ?? insensitive.get(header.toLowerCase())));
}
