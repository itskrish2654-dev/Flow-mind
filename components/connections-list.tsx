"use client";
import { useState } from "react";
import { Link2Off } from "lucide-react";
import { disconnectConnector } from "@/app/actions/connections";

export function ConnectionsList({ connections }: { connections: Array<{ id: string; displayName: string; accountLabel: string; status: string; scopes: string[] }> }) {
  const [busy, setBusy] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null);
  if (!connections.length) return <p className="rounded-xl bg-[#faf8f4] p-4 text-sm text-slate-600">No external accounts are connected. FlowMind only shows Connect when a production connector is genuinely available.</p>;
  return <div className="space-y-3">{connections.map((connection) => <div key={connection.id} className="flex flex-col gap-3 rounded-xl border border-[#e4ddd2] bg-white p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold text-slate-950">{connection.displayName}</p><p className="mt-1 text-xs text-slate-500">{connection.accountLabel} · {connection.status} · {connection.scopes.length} approved scope{connection.scopes.length === 1 ? "" : "s"}</p></div><button type="button" disabled={busy === connection.id} onClick={async () => { setBusy(connection.id); const result = await disconnectConnector(connection.id); setMessage(result.ok ? "Connection removed." : result.error); setBusy(null); }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#d8caa8] px-4 text-xs font-semibold text-slate-700 hover:bg-[#fff8e3] disabled:opacity-60"><Link2Off className="size-4" />{busy === connection.id ? "Disconnecting…" : "Disconnect"}</button></div>)}{message && <p role="status" className="text-sm text-slate-600">{message}</p>}</div>;
}
