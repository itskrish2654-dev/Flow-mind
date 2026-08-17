import {
  Bot,
  Braces,
  Database,
  FileText,
  FormInput,
  PlugZap,
  Webhook,
} from "lucide-react";

import { ConnectionsList } from "@/components/connections-list";
import { listConnectionViews } from "@/lib/connectors/connection-view";
import { createClient } from "@/lib/supabase/server";

const builtInCapabilities = [
  { name: "Webhook", description: "Start a loop from a secure incoming request.", icon: Webhook },
  { name: "HTTP JSON", description: "Send acknowledged JSON requests to public HTTPS endpoints.", icon: Braces },
  { name: "Hosted Forms", description: "Collect structured submissions without another form tool.", icon: FormInput },
  { name: "AI", description: "Transform, summarize, and draft content inside a loop.", icon: Bot },
  { name: "PDF", description: "Generate downloadable documents from your workflow data.", icon: FileText },
  { name: "CrazyLoops Storage", description: "Store submissions and workflow results securely.", icon: Database },
];

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string | string[]; error?: string | string[] }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const connections = await listConnectionViews(user.id);
  const params = await searchParams;
  const connected = typeof params.connected === "string" ? params.connected : null;
  const error = typeof params.error === "string" ? params.error : null;
  const slackAvailable = Boolean(
    process.env.FLOWMIND_CONNECTOR_SLACK_CLIENT_ID
    && process.env.FLOWMIND_CONNECTOR_SLACK_CLIENT_SECRET,
  );
  const notionAvailable = Boolean(
    process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID
    && process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET,
  );

  return (
    <div className="pb-6">
      <div className="flex flex-col gap-5 border-b border-[#ded6ca] pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-[#8a6200]">
            <PlugZap className="size-4" aria-hidden="true" /> Workspace
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Connections</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
            Connect the apps CrazyLoops can use in your workflows. You choose the account for every connected step.
          </p>
        </div>
        <p className="max-w-xs text-xs leading-5 text-slate-500">
          Credentials stay encrypted and are never displayed here.
        </p>
      </div>

      <ConnectionsList
        connections={connections}
        successConnector={connected}
        errorCode={error}
        providerAvailability={{ slack: slackAvailable, notion: notionAvailable }}
      />

      <section className="mt-10" aria-labelledby="built-in-title">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Available</p>
            <h2 id="built-in-title" className="mt-1 text-lg font-semibold tracking-[-0.02em] text-slate-950">Built into CrazyLoops</h2>
          </div>
          <span className="rounded-full bg-[#fff2bd] px-2.5 py-1 text-[10px] font-semibold text-[#795700]">No account required</span>
        </div>
        <div className="mt-4 divide-y divide-[#e8e1d7] overflow-hidden rounded-2xl border border-[#ded6ca] bg-[#fffdfa]">
          {builtInCapabilities.map(({ name, description, icon: Icon }) => (
            <article key={name} className="flex items-start gap-3 px-4 py-3.5 transition hover:bg-[#fffaf0] sm:items-center sm:px-5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#ead89e] bg-[#fff7dc] text-[#8a6200]">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-4">
                <h3 className="text-sm font-semibold text-slate-900 sm:w-44 sm:shrink-0">{name}</h3>
                <p className="mt-1 text-xs leading-5 text-slate-500 sm:mt-0">{description}</p>
              </div>
              <span className="hidden text-[10px] font-semibold text-emerald-700 sm:inline">Ready</span>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
