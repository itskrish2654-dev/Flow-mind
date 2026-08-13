import Link from "next/link";
import { ArrowLeft, Gauge, PlugZap, Settings2, Zap } from "lucide-react";

import { TrustLinks } from "@/components/trust-links";

export function SettingsShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="dashboard-theme h-dvh overflow-y-auto bg-[#f7f4ee] text-slate-800">
      <header className="border-b border-[#e4ddd2] bg-[#fffdfa]">
        <div className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center gap-3 px-4 py-3 sm:px-8">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-bold text-[#272536]"><span className="flex size-8 items-center justify-center rounded-[10px] border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Zap className="size-4 fill-current" /></span>FlowMind</Link>
          <nav aria-label="Account settings" className="order-3 flex w-full items-center gap-1 overflow-x-auto rounded-xl border border-[#e4ddd2] bg-[#faf8f4] p-1 text-xs font-semibold sm:order-none sm:ml-auto sm:w-auto">
            <Link href="/settings" className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 hover:bg-white"><Settings2 className="size-3.5" />Settings</Link>
            <Link href="/settings/usage" className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 hover:bg-white"><Gauge className="size-3.5" />Usage</Link>
            <Link href="/settings/connections" className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 hover:bg-white"><PlugZap className="size-3.5" />Connections</Link>
          </nav>
          <Link href="/dashboard" className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-950"><ArrowLeft className="size-3.5" />Dashboard</Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-4 py-7 sm:px-8 sm:py-10">{children}</div>
      <footer className="mx-auto max-w-5xl border-t border-[#e4ddd2] px-5 py-7 sm:px-8">
        <TrustLinks className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600 [&_a:hover]:text-slate-950" />
      </footer>
    </main>
  );
}
