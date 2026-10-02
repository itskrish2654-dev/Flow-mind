import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { KnowledgeDelete } from "@/components/knowledge-manager";
import { getAuthenticatedContext } from "@/lib/auth";
import { getCompanyKnowledgeDocument } from "@/lib/knowledge";

export default async function KnowledgeDetailPage({ params, searchParams }: {
  params: Promise<{ documentId: string }>;
  searchParams: Promise<{ chunk?: string }>;
}) {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=/knowledge");
  const [{ documentId }, query] = await Promise.all([params, searchParams]);
  const detail = await getCompanyKnowledgeDocument(documentId);
  if (!detail) notFound();
  return <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-12 pt-16 text-[#272536] sm:px-8 lg:pt-8">
    <div className="mx-auto max-w-4xl">
      <Link href="/knowledge" className="text-sm font-semibold text-[#725300] underline underline-offset-4">← Company Knowledge</Link>
      <header className="mt-7 rounded-2xl border border-[#e4ddd2] bg-white p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#856b36]">Shared company source</p>
        <h1 className="mt-2 break-words text-3xl font-semibold">{detail.document.title}</h1>
        <p className="mt-3 text-sm text-slate-600">{detail.document.filename} · {(detail.document.size_bytes / 1024).toFixed(0)} KB · Uploaded {new Date(detail.document.created_at).toLocaleDateString("en-GB")} · {detail.document.status}</p>
        {detail.canManage && <div className="mt-5"><KnowledgeDelete documentId={detail.document.id} /></div>}
      </header>
      {detail.document.status === "ready" ? <section className="mt-6" aria-label="Extracted text sections">
        <p className="mb-4 text-sm text-slate-600">This is extracted text, shown as plain text. Page locations are shown only when the PDF parser provided them.</p>
        <ol className="space-y-3">{detail.chunks.map((chunk) => <li id={`chunk-${chunk.id}`} key={chunk.id}
          className={`scroll-mt-8 rounded-2xl border bg-white p-5 text-sm leading-7 ${query.chunk === chunk.id ? "border-[#b48b2c] ring-2 ring-[#f5df97]" : "border-[#e4ddd2]"}`}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#856b36]">{chunk.page_number ? `Page ${chunk.page_number} · ` : ""}Section {chunk.chunk_index + 1}</p>
          <p className="whitespace-pre-wrap break-words">{chunk.content}</p>
        </li>)}</ol>
      </section> : <p role="status" className="mt-6 rounded-xl bg-white p-5 text-sm">{detail.document.status === "failed" ? detail.document.failure_reason : "This document is not currently available to Ask."}</p>}
    </div>
  </main>;
}
