"use client";

import { useState } from "react";
import { Link2Off } from "lucide-react";

import { disconnectConnector } from "@/app/actions/connections";

type Connection = { id: string; displayName: string; accountLabel: string; status: string; scopes: string[] };
type GoogleConnector = { id: string; name: string; status: string; operation: string };

export function ConnectionsList({ connections, googleConnectors }: { connections: Connection[]; googleConnectors: GoogleConnector[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return <div className="space-y-3">
    <div className="grid gap-2 sm:grid-cols-2">{googleConnectors.map((connector) =>
      <a key={connector.id} href={`/api/connectors/oauth/${connector.id}/start?operation=${encodeURIComponent(connector.operation)}&account=add`} className="rounded-xl border border-[#d8caa8] bg-[#fffdfa] p-3 text-sm font-semibold text-slate-900 hover:bg-[#fff8e3]">
        Connect {connector.name}<span className="ml-2 rounded-full bg-[#fff2bf] px-2 py-0.5 text-[10px] text-[#795700]">{connector.status}</span>
        <span className="mt-1 block text-xs font-normal text-slate-500">Only the permissions needed for {connector.name} are requested.</span>
      </a>)}</div>
    {connections.length === 0 && <p className="rounded-xl bg-[#faf8f4] p-4 text-sm text-slate-600">No Google account is connected yet.</p>}
    {connections.map((connection) => <div key={connection.id} className="flex flex-col gap-3 rounded-xl border border-[#e4ddd2] bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div><p className="text-sm font-semibold text-slate-950">{connection.displayName}</p><p className="mt-1 text-xs text-slate-500">{connection.accountLabel} · {connection.status} · {connection.scopes.length} approved scope{connection.scopes.length === 1 ? "" : "s"}</p></div>
      <div className="flex flex-wrap gap-2">
        <a href={`/api/connectors/oauth/google_gmail/start?operation=new_email&connection=${connection.id}`} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#d8caa8] px-3 text-xs font-semibold text-slate-700 hover:bg-[#fff8e3]">Add Gmail permission</a>
        <a href={`/api/connectors/oauth/google_sheets/start?operation=add_row&connection=${connection.id}`} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#d8caa8] px-3 text-xs font-semibold text-slate-700 hover:bg-[#fff8e3]">Add Sheets permission</a>
        <button type="button" disabled={busy === connection.id} onClick={async () => { setBusy(connection.id); const result = await disconnectConnector(connection.id); setMessage(result.ok ? "Connection removed." : result.error); setBusy(null); }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#d8caa8] px-4 text-xs font-semibold text-slate-700 hover:bg-[#fff8e3] disabled:opacity-60"><Link2Off className="size-4" />{busy === connection.id ? "Disconnecting…" : "Disconnect"}</button>
      </div>
    </div>)}
    {message && <p role="status" className="text-sm text-slate-600">{message}</p>}
  </div>;
}
