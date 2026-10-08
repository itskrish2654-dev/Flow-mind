import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getAuthenticatedContext } from "@/lib/auth";
import { readNotionPage } from "@/lib/connectors/notion/read";

export const dynamic = "force-dynamic";

export default async function NotionSourcePage({ params }: {
  params: Promise<{ connectionId: string; pageId: string }>;
}) {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=%2Fdashboard");
  const { connectionId, pageId } = await params;
  const page = await readNotionPage({ userId: auth.user.id, workspaceId: auth.workspace.id, connectionId, pageId });
  if (!page) notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 pb-8 pt-20 sm:px-6 lg:pt-8">
      <Link href="/ask" className="text-sm font-medium text-blue-700 hover:underline">Back to Ask CrazyLoops</Link>
      <p className="mt-8 text-xs font-semibold uppercase tracking-widest text-slate-500">Shared Notion source</p>
      <h1 className="mt-2 break-words text-2xl font-semibold text-slate-950">{page.title}</h1>
      <p className="mt-2 text-sm text-slate-600">Only the first 100 top-level blocks are shown. This is not a complete search of Notion.</p>
      <section aria-label="Notion page text" className="mt-6 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">
        {page.content || "No readable text was found in the inspected blocks."}
      </section>
    </main>
  );
}
