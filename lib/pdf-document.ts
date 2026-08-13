import { readFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

export type DocumentVariables = Record<string, unknown>;

const MAX_PDF_SOURCE_CHARACTERS = 50_000;
const EMOJI_FALLBACK = "[emoji]";
const FONT_ROOT = path.join(process.cwd(), "node_modules", "@fontsource");
const FONT_PATHS = {
  latin: path.join(FONT_ROOT, "noto-sans", "files", "noto-sans-latin-400-normal.woff"),
  latinBold: path.join(FONT_ROOT, "noto-sans", "files", "noto-sans-latin-700-normal.woff"),
  devanagari: path.join(FONT_ROOT, "noto-sans-devanagari", "files", "noto-sans-devanagari-devanagari-400-normal.woff"),
  devanagariBold: path.join(FONT_ROOT, "noto-sans-devanagari", "files", "noto-sans-devanagari-devanagari-700-normal.woff"),
  japaneseRoot: path.join(FONT_ROOT, "noto-sans-jp"),
} as const;

type FontRun = { font: string; text: string };
type UnicodeRange = { start: number; end: number };
type JapaneseSubset = { name: string; ranges: UnicodeRange[]; path: string };

export class PdfRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfRenderError";
  }
}

let japaneseSubsetsPromise: Promise<JapaneseSubset[]> | null = null;

function readVariable(variables: DocumentVariables, pathValue: string): unknown {
  const direct = variables[pathValue];
  if (direct !== undefined && direct !== null) return direct;
  return pathValue.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, variables);
}

function variableText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function populateDocumentTemplate(template: string, variables: DocumentVariables): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) =>
    variableText(readVariable(variables, key)),
  );
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[*_~`]/g, "")
    .trim();
}

export function applyPdfEmojiPolicy(value: string): string {
  return value
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu, EMOJI_FALLBACK)
    .replace(/[\uFE0E\uFE0F]/g, "");
}

export function assertPdfScriptSupport(value: string): void {
  if (/\p{Script=Arabic}/u.test(value)) {
    throw new PdfRenderError(
      "Arabic and other right-to-left PDF text are not supported yet because FlowMind cannot guarantee correct glyph shaping. Use Latin, Hindi, Chinese, or Japanese text, or remove the Arabic text before generating this PDF.",
    );
  }
}

function parseUnicodeRange(value: string): UnicodeRange[] {
  return value.split(",").map((entry) => {
    const [startValue, endValue] = entry.trim().replace(/^U\+/i, "").split("-");
    const start = Number.parseInt(startValue, 16);
    return { start, end: endValue ? Number.parseInt(endValue, 16) : start };
  });
}

async function loadJapaneseSubsets(): Promise<JapaneseSubset[]> {
  if (!japaneseSubsetsPromise) {
    japaneseSubsetsPromise = readFile(path.join(FONT_PATHS.japaneseRoot, "unicode.json"), "utf8")
      .then((source) => Object.entries(JSON.parse(source) as Record<string, string>).map(([key, ranges]) => {
        const index = key.replace(/[\[\]]/g, "");
        return {
          name: `FlowMindCJK${index}`,
          ranges: parseUnicodeRange(ranges),
          path: path.join(FONT_PATHS.japaneseRoot, "files", `noto-sans-jp-${index}-400-normal.woff`),
        };
      }));
  }
  return japaneseSubsetsPromise;
}

function inRange(codePoint: number, ranges: UnicodeRange[]): boolean {
  return ranges.some((range) => codePoint >= range.start && codePoint <= range.end);
}

async function fontRuns(value: string, bold: boolean, document: PDFKit.PDFDocument): Promise<FontRun[]> {
  const normalized = applyPdfEmojiPolicy(value.normalize("NFC"));
  const cjkSubsets = await loadJapaneseSubsets();
  const registered = new Set<string>();
  const runs: FontRun[] = [];

  const append = (font: string, text: string) => {
    const previous = runs.at(-1);
    if (previous?.font === font) previous.text += text;
    else runs.push({ font, text });
  };

  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (inRange(codePoint, [{ start: 0x0900, end: 0x097f }])) {
      append(bold ? "FlowMindDevanagariBold" : "FlowMindDevanagari", character);
      continue;
    }
    if (inRange(codePoint, [{ start: 0x3040, end: 0x30ff }, { start: 0x3400, end: 0x9fff }])) {
      const subset = cjkSubsets.find((item) => inRange(codePoint, item.ranges));
      if (!subset) throw new PdfRenderError(`The PDF font does not contain the character U+${codePoint.toString(16).toUpperCase()}.`);
      if (!registered.has(subset.name)) {
        document.registerFont(subset.name, subset.path);
        registered.add(subset.name);
      }
      append(subset.name, character);
      continue;
    }
    append(bold ? "FlowMindLatinBold" : "FlowMindLatin", character);
  }
  return runs;
}

async function writeRuns(
  document: PDFKit.PDFDocument,
  value: string,
  options: { bold?: boolean; size: number; color?: string; indent?: number; paragraphGap?: number; align?: "left" | "right" },
): Promise<void> {
  const runs = await fontRuns(stripInlineMarkdown(value), Boolean(options.bold), document);
  runs.forEach((run, index) => {
    document.font(run.font).fontSize(options.size).fillColor(options.color ?? "#1f2937").text(run.text, {
      continued: index < runs.length - 1,
      width: document.page.width - document.page.margins.left - document.page.margins.right - (options.indent ?? 0),
      indent: options.indent ?? 0,
      lineGap: Math.max(2, options.size * 0.35),
      paragraphGap: index === runs.length - 1 ? options.paragraphGap ?? 5 : 0,
      align: options.align ?? "left",
    });
  });
  if (runs.length === 0) document.moveDown(0.5);
}

export async function generatePdfBuffer(markdown: string): Promise<Uint8Array> {
  if (markdown.length > MAX_PDF_SOURCE_CHARACTERS) {
    throw new PdfRenderError(`PDF content is limited to ${MAX_PDF_SOURCE_CHARACTERS.toLocaleString()} characters.`);
  }
  assertPdfScriptSupport(markdown);

  const document = new PDFDocument({
    size: "A4",
    margins: { top: 60, right: 54, bottom: 62, left: 54 },
    bufferPages: true,
    info: { Producer: "FlowMind", Creator: "FlowMind Native Document Engine" },
  });
  document.registerFont("FlowMindLatin", FONT_PATHS.latin);
  document.registerFont("FlowMindLatinBold", FONT_PATHS.latinBold);
  document.registerFont("FlowMindDevanagari", FONT_PATHS.devanagari);
  document.registerFont("FlowMindDevanagariBold", FONT_PATHS.devanagariBold);

  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Uint8Array>((resolve, reject) => {
    document.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    document.on("error", reject);
  });

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      document.moveDown(0.45);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      document.moveDown(0.25).strokeColor("#d7dce4").lineWidth(0.8)
        .moveTo(document.page.margins.left, document.y)
        .lineTo(document.page.width - document.page.margins.right, document.y).stroke().moveDown(0.55);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const size = heading[1].length === 1 ? 23 : heading[1].length === 2 ? 17 : 13;
      await writeRuns(document, heading[2], { bold: true, size, paragraphGap: size * 0.55 });
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      await writeRuns(document, `• ${bullet[1]}`, { size: 10.5, indent: 12, paragraphGap: 2 });
      continue;
    }
    await writeRuns(document, line, { size: 10.5, paragraphGap: 5 });
  }

  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    document.font("FlowMindLatin").fontSize(8).fillColor("#64748b").text(
      `Generated by FlowMind  |  Page ${index + 1} of ${range.count}`,
      document.page.margins.left,
      document.page.height - 36,
      { lineBreak: false },
    );
  }
  document.end();
  return completed;
}
