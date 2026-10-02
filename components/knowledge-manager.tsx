"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { KNOWLEDGE_LIMITS } from "@/lib/knowledge-core";

export function KnowledgeUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const file = new FormData(form).get("file");
    if (!(file instanceof File) || file.size > KNOWLEDGE_LIMITS.fileBytes) {
      setMessage("Choose a PDF, .txt, or .md file of 3 MB or less."); return;
    }
    setBusy(true); setMessage("Processing and indexing your document…");
    try {
      const response = await fetch("/api/knowledge/upload", { method: "POST", body: new FormData(form) });
      const result = await response.json() as { error?: string; status?: string };
      if (!response.ok) throw new Error(result.error ?? "Upload failed.");
      setMessage(result.status === "ready" ? "Document indexed and ready for Ask." : "This document is already being processed.");
      form.reset(); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Upload failed."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="rounded-2xl border border-[#ddd5c9] bg-white p-5 shadow-sm">
    <label htmlFor="knowledge-file" className="block text-sm font-semibold">Add a company document</label>
    <p className="mt-1 text-xs leading-5 text-slate-600">PDF with extractable text, .txt, or .md · up to 3 MB · PDFs up to 30 pages. No OCR.</p>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <input id="knowledge-file" name="file" type="file" required accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" disabled={busy}
        className="min-w-0 max-w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[#f7efd4] file:px-3 file:py-2 file:font-semibold" />
      <button disabled={busy} className="min-h-11 rounded-xl bg-[#3d315b] px-5 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Indexing…" : "Upload"}</button>
    </div>
    <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-700">{message}</p>
  </form>;
}

export function KnowledgeDelete({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function remove() {
    if (busy || !window.confirm("Remove this document from company knowledge? This cannot be undone.")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/knowledge/${documentId}/delete`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Deletion failed.");
      setMessage("Document removed."); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Deletion failed."); }
    finally { setBusy(false); }
  }
  return <div><button type="button" onClick={remove} disabled={busy}
    className="min-h-10 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:opacity-60">{busy ? "Removing…" : "Delete document"}</button>
    <p role="status" className="mt-1 text-xs text-red-800">{message}</p></div>;
}
