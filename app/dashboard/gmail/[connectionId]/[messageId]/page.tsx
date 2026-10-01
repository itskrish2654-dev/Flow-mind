import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getAuthenticatedContext } from "@/lib/auth";
import { readGmailMessage } from "@/lib/connectors/google/gmail-read";

export const dynamic = "force-dynamic";

export default async function GmailMessagePage({
  params,
}: {
  params: Promise<{ connectionId: string; messageId: string }>;
}) {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=%2Fdashboard");
  const { connectionId, messageId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) notFound();
  const message = await readGmailMessage({ userId: auth.user.id, workspaceId: auth.workspace.id,
    connectionId, messageId });
  if (!message) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/ask" className="text-sm font-medium text-blue-700 hover:underline">Back to Ask CrazyLoops</Link>
      <p className="mt-8 text-xs font-semibold uppercase tracking-widest text-slate-500">Gmail source</p>
      <h1 className="mt-2 break-words text-2xl font-semibold text-slate-950">{message.subject || "(No subject)"}</h1>
      <dl className="mt-6 grid gap-3 border-y border-slate-200 py-5 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="font-medium text-slate-600">From</dt><dd className="break-all text-slate-900">{message.from}</dd>
        <dt className="font-medium text-slate-600">To</dt><dd className="break-all text-slate-900">{message.to}</dd>
        <dt className="font-medium text-slate-600">Received</dt><dd className="text-slate-900">{message.receivedAt}</dd>
      </dl>
      <section aria-label="Email text" className="mt-6 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">
        {message.text || "No readable text body was available."}
      </section>
      {message.attachments.length > 0 && (
        <section className="mt-8" aria-label="Attachment metadata">
          <h2 className="text-sm font-semibold text-slate-900">Attachments (metadata only)</h2>
          <ul className="mt-2 list-inside list-disc text-sm text-slate-700">
            {message.attachments.map((attachment, index) => (
              <li key={`${index}:${attachment.filename}`} className="break-words">
                {String(attachment.filename ?? "Unnamed file")} — {String(attachment.mimeType ?? "unknown type")}, {String(attachment.size ?? 0)} bytes
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
