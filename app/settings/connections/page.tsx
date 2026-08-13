import { PlugZap } from "lucide-react";
import { ConnectionsList } from "@/components/connections-list";
import { listCustomerConnectors } from "@/lib/connectors/registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export default async function ConnectionsPage() {
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return null;
  const { data } = await createAdminClient().from("connector_connections").select("id, connector_id, external_account_label, external_account_id, status, granted_scopes").eq("user_id", user.id).neq("status", "revoked").order("created_at", { ascending: false });
  const manifests = new Map(listCustomerConnectors().map((manifest) => [manifest.id, manifest]));
  const connections = (data ?? []).flatMap((item) => { const manifest = manifests.get(item.connector_id); return manifest ? [{ id: item.id, displayName: manifest.displayName, accountLabel: item.external_account_label ?? item.external_account_id, status: item.status, scopes: item.granted_scopes }] : []; });
  const utilities = listCustomerConnectors().filter((manifest) => manifest.auth.type === "none");
  return <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#8a6200]">Account</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Connections</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Manage real provider accounts used by workflows. Tokens remain encrypted and are never returned to this page.</p><section className="mt-8 rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6"><h2 className="flex items-center gap-2 text-base font-semibold text-slate-950"><PlugZap className="size-5 text-[#9a7007]" />Connected accounts</h2><div className="mt-5"><ConnectionsList connections={connections} /></div></section><section className="mt-5 rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6"><h2 className="text-base font-semibold text-slate-950">Built-in connector utilities</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{utilities.map((manifest) => <article key={manifest.id} className="rounded-xl bg-[#faf8f4] p-4"><p className="text-sm font-semibold text-slate-900">{manifest.displayName}</p><p className="mt-1 text-xs leading-5 text-slate-500">{manifest.description}</p><span className="mt-3 inline-flex rounded-full bg-[#fff2bf] px-2.5 py-1 text-[11px] font-semibold text-[#795700]">No external account required</span></article>)}</div></section></div>;
}
