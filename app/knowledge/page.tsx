import Link from "next/link";
import { redirect } from "next/navigation";

import { KnowledgeDelete, KnowledgeUpload } from "@/components/knowledge-manager";
import { getAuthenticatedContext } from "@/lib/auth";
import { listCompanyKnowledge } from "@/lib/knowledge";

export default async function KnowledgePage() {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=/knowledge");
  const { documents, canManage } = await listCompanyKnowledge();
  return <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-12 pt-16 text-[#272536] sm:px-8 lg:pt-8">
    <div className="mx-auto max-w-4xl">
      <header className="mb-7"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#856b36]">Work OS</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Company Knowledge</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Ask CrazyLoops uses these company documents as grounded sources. Everyone in this workspace can read them; only owners and admins can manage them. Uploaded text never instructs CrazyLoops to take an action.</p>
      </header>
      {canManage && <div className="mb-7"><KnowledgeUpload /></div>}
      <section aria-label="Shared documents">
        {documents.length === 0 ? <div className="rounded-2xl border border-dashed border-[#d8caa8] bg-white p-8 text-center">
          <h2 className="text-lg font-semibold">No company documents yet</h2>
          <p className="mt-2 text-sm text-slate-600">{canManage ? "Add a handbook or SOP to give your team a grounded source in Ask." : "An owner or admin can add shared documents here."}</p>
        </div> : <ul className="space-y-3">{documents.map((document) => {
          const status = document.processingStale ? "Processing interrupted — ask an admin to remove and upload again" : document.status === "ready" ? "Ready for Ask" : document.status === "failed" ? "Could not index" : document.status === "deleting" ? "Removal pending" : "Processing";
          return <li key={document.id} className="rounded-2xl border border-[#e4ddd2] bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0">
              <h2 className="break-words text-base font-semibold"><Link href={`/knowledge/${document.id}`} className="hover:underline focus-visible:outline-2 focus-visible:outline-offset-2">{document.title}</Link></h2>
              <p className="mt-1 text-xs text-slate-600">{document.filename} · {(document.size_bytes / 1024).toFixed(0)} KB · {new Date(document.created_at).toLocaleDateString("en-GB")} · {document.uploaded_by_user_id === auth.user.id ? "Uploaded by you" : "Uploaded by a teammate"}</p>
            </div><span className="rounded-full bg-[#f8f4ec] px-3 py-1 text-xs font-medium text-slate-700">{status}</span></div>
            {document.status === "failed" && <p className="mt-2 text-sm text-red-800">{document.failure_reason ?? "Extraction failed."}</p>}
            {document.status === "ready" && <p className="mt-2 text-xs text-slate-600">{document.chunk_count} indexed sections{document.page_count ? ` · ${document.page_count} pages` : ""}</p>}
            {canManage && <div className="mt-4"><KnowledgeDelete documentId={document.id} /></div>}
          </li>;
        })}</ul>}
      </section>
    </div>
  </main>;
}
