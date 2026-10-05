import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getAuthenticatedContext } from "@/lib/auth";
import { readSlackMessage } from "@/lib/connectors/slack/read";

export const dynamic = "force-dynamic";

export default async function SlackMessagePage({
  params,
}: {
  params: Promise<{ connectionId: string; eventId: string }>;
}) {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=%2Fdashboard");
  const { connectionId, eventId } = await params;
  const message = await readSlackMessage({ userId: auth.user.id, workspaceId: auth.workspace.id, connectionId, eventId });
  if (!message) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/ask" className="text-sm font-medium text-blue-700 hover:underline">Back to Ask CrazyLoops</Link>
      <p className="mt-8 text-xs font-semibold uppercase tracking-widest text-slate-500">Captured Slack source</p>
      <h1 className="mt-2 break-words text-2xl font-semibold text-slate-950">Public-channel message</h1>
      <p className="mt-2 text-sm text-slate-600">CrazyLoops captured this signed event after the Slack app was connected. This is not a complete channel history.</p>
      <dl className="mt-6 grid gap-3 border-y border-slate-200 py-5 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="font-medium text-slate-600">Channel</dt><dd className="break-all text-slate-900">{message.channel_id}</dd>
        <dt className="font-medium text-slate-600">Sender</dt><dd className="break-all text-slate-900">{message.sender_id}</dd>
        <dt className="font-medium text-slate-600">Posted</dt><dd className="text-slate-900">{message.message_at}</dd>
      </dl>
      <section aria-label="Slack message text" className="mt-6 whitespace-pre-wrap break-words text-sm leading-7 text-slate-800">
        {message.message_text}
      </section>
    </main>
  );
}
