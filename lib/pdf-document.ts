import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";

export type DocumentVariables = Record<string, unknown>;

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 58;
const TOP = 72;
const BOTTOM = 58;

function readVariable(variables: DocumentVariables, path: string): unknown {
  const direct = variables[path];
  if (direct !== undefined && direct !== null) return direct;

  return path.split(".").reduce<unknown>((value, segment) => {
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

export function populateDocumentTemplate(
  template: string,
  variables: DocumentVariables,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) =>
    variableText(readVariable(variables, key)),
  );
}

function printableText(value: string): string {
  return value
    .replaceAll("\u2018", "'")
    .replaceAll("\u2019", "'")
    .replaceAll("\u201c", '"')
    .replaceAll("\u201d", '"')
    .replaceAll("\u2013", "-")
    .replaceAll("\u2014", "-")
    .replaceAll("\u2022", "-")
    .replaceAll("\u2026", "...")
    .normalize("NFKD")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function stripInlineMarkdown(value: string): string {
  return printableText(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/[*_~`]/g, "")
    .trim();
}

function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);
    line = word;
    while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
      let splitAt = line.length - 1;
      while (splitAt > 1 && font.widthOfTextAtSize(line.slice(0, splitAt), size) > width) {
        splitAt -= 1;
      }
      lines.push(line.slice(0, splitAt));
      line = line.slice(splitAt);
    }
  }

  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

export async function generatePdfBuffer(markdown: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const textColor = rgb(0.12, 0.16, 0.24);
  const mutedColor = rgb(0.4, 0.45, 0.55);
  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - TOP;

  const newPage = () => {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - TOP;
  };

  const drawBlock = (
    text: string,
    options: { font: PDFFont; size: number; lineHeight: number; indent?: number; gap?: number },
  ) => {
    const indent = options.indent ?? 0;
    const lines = wrapText(
      stripInlineMarkdown(text),
      options.font,
      options.size,
      PAGE_WIDTH - MARGIN_X * 2 - indent,
    );
    for (const line of lines) {
      if (y - options.lineHeight < BOTTOM) newPage();
      page.drawText(line, {
        x: MARGIN_X + indent,
        y,
        size: options.size,
        font: options.font,
        color: textColor,
      });
      y -= options.lineHeight;
    }
    y -= options.gap ?? 5;
  };

  for (const rawLine of printableText(markdown).split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      y -= 7;
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      if (y - 12 < BOTTOM) newPage();
      page.drawLine({
        start: { x: MARGIN_X, y },
        end: { x: PAGE_WIDTH - MARGIN_X, y },
        thickness: 0.8,
        color: rgb(0.85, 0.87, 0.91),
      });
      y -= 14;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const size = level === 1 ? 24 : level === 2 ? 17 : 13;
      y -= level === 1 ? 2 : 5;
      drawBlock(heading[2], {
        font: bold,
        size,
        lineHeight: size * 1.25,
        gap: level === 1 ? 12 : 8,
      });
      continue;
    }

    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      drawBlock(`- ${bullet[1]}`, {
        font: regular,
        size: 10.5,
        lineHeight: 15,
        indent: 10,
        gap: 2,
      });
      continue;
    }

    drawBlock(line, { font: regular, size: 10.5, lineHeight: 15, gap: 5 });
  }

  const pages = document.getPages();
  pages.forEach((documentPage, index) => {
    const footer = `Generated by FlowMind  |  Page ${index + 1} of ${pages.length}`;
    documentPage.drawText(footer, {
      x: MARGIN_X,
      y: 28,
      size: 8,
      font: regular,
      color: mutedColor,
    });
  });

  document.setProducer("FlowMind");
  document.setCreator("FlowMind Native Document Engine");
  document.setCreationDate(new Date());
  return document.save();
}
