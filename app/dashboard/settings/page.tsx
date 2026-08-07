import { Bot, CheckCircle2, Save, Settings2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const connections = [
  {
    name: "Saving your automations",
    description: "Your automations are saved automatically.",
    icon: Save,
    configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  },
  {
    name: "Your AI helper",
    description: "Your AI helper is ready to build new automations.",
    icon: Bot,
    configured: Boolean(process.env.GROQ_API_KEY),
  },
];

export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-5 py-10 sm:px-8 lg:px-10">
      <div>
        <p className="text-xs font-semibold text-violet-600">Your workspace</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Settings</h1>
        <p className="mt-2 text-sm text-slate-500">A quick check that everything is ready.</p>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        {connections.map((connection) => {
          const Icon = connection.icon;
          return (
            <Card key={connection.name} className="gap-0 rounded-2xl border border-slate-200 bg-white py-0 shadow-sm ring-0">
              <CardHeader className="flex flex-row items-center justify-between border-b border-slate-100 px-5 py-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><Icon className="size-[18px]" /></span>
                  <div>
                    <h2 className="text-sm font-semibold text-slate-800">{connection.name}</h2>
                    <p className="mt-0.5 text-[11px] text-slate-400">FlowPilot service</p>
                  </div>
                </div>
                <Badge className={`gap-1 border px-2 text-[10px] ${connection.configured ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
                  {connection.configured && <CheckCircle2 className="size-3" />}
                  {connection.configured ? "Ready" : "Needs attention"}
                </Badge>
              </CardHeader>
              <CardContent className="px-5 py-4 text-xs leading-5 text-slate-500">{connection.description}</CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-6 flex items-center gap-2 text-[11px] text-slate-400"><Settings2 className="size-3.5" /> FlowPilot keeps the technical details out of your way.</div>
    </div>
  );
}
