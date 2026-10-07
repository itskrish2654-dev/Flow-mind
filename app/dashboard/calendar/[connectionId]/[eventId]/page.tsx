import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getAuthenticatedContext } from "@/lib/auth";
import { readGoogleCalendarEvent } from "@/lib/connectors/google/calendar";

export const dynamic = "force-dynamic";

export default async function CalendarEventPage({ params }: {
  params: Promise<{ connectionId: string; eventId: string }>;
}) {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=%2Fdashboard");
  const { connectionId, eventId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) notFound();
  const event = await readGoogleCalendarEvent({ userId: auth.user.id, workspaceId: auth.workspace.id,
    connectionId, eventId });
  if (!event) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/ask" className="text-sm font-medium text-blue-700 hover:underline">Back to Ask CrazyLoops</Link>
      <p className="mt-8 text-xs font-semibold uppercase tracking-widest text-slate-500">Google Calendar source</p>
      <h1 className="mt-2 break-words text-2xl font-semibold text-slate-950">{event.summary}</h1>
      <dl className="mt-6 grid gap-3 border-y border-slate-200 py-5 text-sm sm:grid-cols-[6rem_1fr]">
        <dt className="font-medium text-slate-600">Starts</dt><dd className="break-words text-slate-900">{event.startAt}</dd>
        <dt className="font-medium text-slate-600">Ends</dt><dd className="break-words text-slate-900">{event.endAt}</dd>
        {event.timeZone && <><dt className="font-medium text-slate-600">Time zone</dt><dd className="text-slate-900">{event.timeZone}</dd></>}
      </dl>
      <p className="mt-5 text-sm text-slate-600">This event was read from the connected account’s primary calendar. CrazyLoops does not display attendee or private description data here.</p>
    </main>
  );
}
