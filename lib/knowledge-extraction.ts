import { chunkKnowledgePages, KNOWLEDGE_LIMITS, type KnowledgeMime, type KnowledgePage } from "@/lib/knowledge-core";

export async function extractKnowledge(bytes: Uint8Array, mime: KnowledgeMime) {
  let pages: KnowledgePage[];
  if (mime === "application/pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true });
    try {
      const document = await task.promise;
      if (document.numPages > KNOWLEDGE_LIMITS.pages) throw new Error("PDF documents may contain no more than 30 pages.");
      pages = [];
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? item.str : "").join(" ");
        pages.push({ pageNumber: number, text });
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  } else {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Text files must use valid UTF-8 encoding."); }
    pages = [{ pageNumber: null, text }];
  }
  const result = chunkKnowledgePages(pages);
  return { ...result, pageCount: mime === "application/pdf" ? pages.length : null };
}
