import Link from "next/link";
import { ArrowLeft, Gauge, Settings2, Zap } from "lucide-react";

import { TrustLinks } from "@/components/trust-links";

export function SettingsShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="dashboard-theme h-dvh overflow-y-auto bg-[#f7f4ee] text-slate-800">
      <header className="border-b border-[#e4ddd2] bg-[#fffdfa]">
        <div className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center gap-4 px-5 py-3 sm:px-8">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-bold text-[#272536]"><span className="flex size-8 items-center justify-center rounded-[10px] border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Zap className="size-4 fill-current" /></span>FlowMind</Link>
          <nav aria-label="Account settings" className="ml-auto flex items-center gap-1 rounded-xl border border-[#e4ddd2] bg-[#faf8f4] p-1 text-xs font-semibold">
            <Link href="/settings" className="flex items-center gap-1.5 rounded-lg px-3 py-2 hover:bg-white"><Settings2 className="size-3.5" />Settings</Link>
            <Link href="/settings/usage" className="flex items-center gap-1.5 rounded-lg px-3 py-2 hover:bg-white"><Gauge className="size-3.5" />Usage</Link>
          </nav>
          <Link href="/dashboard" className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-950"><ArrowLeft className="size-3.5" />Dashboard</Link>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8">{children}</div>
      <footer className="mx-auto max-w-5xl border-t border-[#e4ddd2] px-5 py-7 sm:px-8">
        <TrustLinks className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600 [&_a:hover]:text-slate-950" />
      </footer>
    </main>
  );
}
