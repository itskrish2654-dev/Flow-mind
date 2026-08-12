import Link from "next/link";
import { ArrowLeft, Zap } from "lucide-react";

import { TrustLinks } from "@/components/trust-links";

export function LegalPageShell({
  eyebrow,
  title,
  description,
  updated = "August 12, 2026",
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  updated?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="dashboard-theme h-dvh overflow-y-auto bg-[#f7f4ee] text-slate-800">
      <header className="sticky top-0 z-10 border-b border-[#e4ddd2] bg-[#fffdfa]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center px-5 sm:px-8">
          <Link href="/login" className="flex items-center gap-2.5 text-sm font-bold text-[#272536]">
            <span className="flex size-8 items-center justify-center rounded-[10px] border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Zap className="size-4 fill-current" /></span>
            FlowMind
          </Link>
          <Link href="/login" className="ml-auto flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-950"><ArrowLeft className="size-3.5" />Back to login</Link>
        </div>
      </header>
      <article className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8a6200]">{eyebrow}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950 sm:text-4xl">{title}</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">{description}</p>
        <p className="mt-3 text-xs text-slate-500">Last updated: {updated}</p>
        <div className="legal-copy mt-10 space-y-9 [&_a]:font-medium [&_a]:text-[#806000] [&_a]:underline [&_a]:underline-offset-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-slate-950 [&_li]:leading-7 [&_p]:leading-7 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
          {children}
        </div>
      </article>
      <footer className="border-t border-[#e4ddd2] bg-[#fffdfa]">
        <div className="mx-auto max-w-5xl px-5 py-7 sm:px-8">
          <TrustLinks className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600 [&_a:hover]:text-slate-950" />
          <p className="mt-4 text-[11px] text-slate-500">FlowMind account and automation services.</p>
        </div>
      </footer>
    </main>
  );
}
