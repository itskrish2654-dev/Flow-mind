export const KNOWLEDGE_LIMITS = {
  fileBytes: 3 * 1024 * 1024,
  pages: 30,
  characters: 80_000,
  chunks: 200,
  chunkCharacters: 460,
  documentsPerWorkspace: 50,
} as const;

export type KnowledgeMime = "application/pdf" | "text/plain" | "text/markdown";
export type KnowledgePage = { pageNumber: number | null; text: string };
export type KnowledgeChunk = { chunkIndex: number; pageNumber: number | null; content: string };

export function soleOwnerWorkspaceWillBeRemoved(input: {
  deletingUserId: string;
  otherMemberCount: number;
  workflowOwnerIds: readonly (string | null)[];
  remainingConnectionCount: number;
}): boolean {
  return input.otherMemberCount === 0 && input.remainingConnectionCount === 0
    && input.workflowOwnerIds.every((ownerId) => ownerId === input.deletingUserId);
}

const SUPPORTED = new Map<string, KnowledgeMime>([
  ["pdf", "application/pdf"], ["txt", "text/plain"], ["md", "text/markdown"],
]);

export function validateKnowledgeFile(input: {
  name: string; mime: string; bytes: Uint8Array;
}): { filename: string; title: string; mime: KnowledgeMime } {
  const filename = input.name.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = SUPPORTED.get(extension);
  if (!mime || !filename || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw new Error("Choose a PDF, .txt, or .md file with a valid filename.");
  }
  if (input.mime && input.mime !== mime && !(mime === "text/markdown" && input.mime === "text/plain")) {
    throw new Error("The file type does not match its extension.");
  }
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > KNOWLEDGE_LIMITS.fileBytes) {
    throw new Error("Choose a non-empty file of 3 MB or less.");
  }
  const pdfMagic = new TextDecoder("ascii").decode(input.bytes.subarray(0, 5)) === "%PDF-";
  if ((mime === "application/pdf") !== pdfMagic) throw new Error("The file contents do not match its type.");
  if (mime !== "application/pdf" && input.bytes.subarray(0, 1024).includes(0)) {
    throw new Error("Binary files cannot be indexed as text.");
  }
  const title = filename.replace(/\.[^.]+$/, "").trim().slice(0, 180);
  if (!title) throw new Error("The document needs a title.");
  return { filename, title, mime };
}

export function normalizeKnowledgeText(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function chunkKnowledgePages(pages: readonly KnowledgePage[]): {
  chunks: KnowledgeChunk[]; characterCount: number;
} {
  if (pages.length < 1 || pages.length > KNOWLEDGE_LIMITS.pages) {
    throw new Error("PDF documents may contain no more than 30 pages.");
  }
  const chunks: KnowledgeChunk[] = [];
  let characterCount = 0;
  for (const page of pages) {
    const text = normalizeKnowledgeText(page.text);
    characterCount += text.length;
    if (characterCount > KNOWLEDGE_LIMITS.characters) {
      throw new Error("The document contains more than 80,000 extractable characters.");
    }
    const words = text.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      if (word.length > KNOWLEDGE_LIMITS.chunkCharacters) throw new Error("The document contains an oversized unbroken text segment.");
      if (current && current.length + 1 + word.length > KNOWLEDGE_LIMITS.chunkCharacters) {
        chunks.push({ chunkIndex: chunks.length, pageNumber: page.pageNumber, content: current });
        current = "";
      }
      current = current ? `${current} ${word}` : word;
      if (chunks.length >= KNOWLEDGE_LIMITS.chunks) throw new Error("The document exceeds the indexing limit of 200 sections.");
    }
    if (current) chunks.push({ chunkIndex: chunks.length, pageNumber: page.pageNumber, content: current });
    if (chunks.length > KNOWLEDGE_LIMITS.chunks) throw new Error("The document exceeds the indexing limit of 200 sections.");
  }
  if (chunks.length === 0) throw new Error("No extractable text was found.");
  return { chunks, characterCount };
}

const QUERY_STOPWORDS = new Set([
  "what", "which", "where", "when", "who", "how", "why", "does", "do", "did", "is", "are", "was", "were", "the", "a", "an", "our", "we", "us", "of", "for", "to", "in", "on", "from", "about", "according", "document", "company", "say", "says", "policy", "sop", "process", "require", "requirements", "above", "below", "with", "and", "or", "it", "there", "any",
]);

export function knowledgeSearchQuery(question: string): string {
  return [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((word) => !QUERY_STOPWORDS.has(word)))].slice(0, 8).join(" OR ");
}

export function safeKnowledgeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^No extractable text was found\.$/.test(message)
    || /^PDF documents may contain no more than 30 pages\.$/.test(message)
    || /^The document (?:contains more than 80,000 extractable characters|contains an oversized unbroken text segment|exceeds the indexing limit of 200 sections)\.$/.test(message)
    || /^Text files must use valid UTF-8 encoding\.$/.test(message)) return message;
  return "The document could not be indexed. Try a different extractable-text file.";
}
