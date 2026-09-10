"use client";

import Link from "next/link";
import { ArrowRight, Check, Sparkles } from "lucide-react";
import { useState } from "react";

import type { MyDayItem } from "@/lib/my-day-model";

export function StartMyDay({ summary, startWith }: { summary: string; startWith: MyDayItem | null }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={() => setRevealed(true)}
        aria-expanded={revealed}
        aria-controls="my-day-briefing"
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#caa137] bg-[#f4c84c] px-4 text-sm font-semibold text-[#272536] shadow-[0_8px_24px_rgba(120,91,15,0.12)] transition hover:border-[#b58a1d] hover:bg-[#efc13b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9b7309] focus-visible:ring-offset-2 disabled:cursor-default"
        disabled={revealed}
      >
        {revealed ? <Check className="size-4" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
        {revealed ? "Briefing ready" : "Start My Day"}
      </button>

      {revealed && (
        <div
          id="my-day-briefing"
          role="status"
          className="mt-4 max-w-2xl rounded-2xl border border-[#e0d4b5] bg-[#fffdf7] p-5 shadow-[0_14px_40px_rgba(50,43,30,0.06)]"
        >
          <p className="text-sm leading-6 text-slate-700">{summary}</p>
          {startWith ? (
            <div className="mt-4 border-t border-[#ece3d2] pt-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#8a6200]">Start with</p>
              <p className="mt-1 text-sm font-semibold text-slate-950">{startWith.title}</p>
              <p className="mt-1 text-xs leading-5 text-slate-600">{startWith.source}</p>
              <Link
                href={startWith.cta.href}
                className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 text-sm font-semibold text-[#735400] underline decoration-[#d9b64b] decoration-2 underline-offset-4 hover:text-[#4f3900] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9b7309] focus-visible:ring-offset-2"
              >
                {startWith.cta.label}<ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm font-medium text-emerald-700">You are clear to choose what to build next.</p>
          )}
        </div>
      )}
    </div>
  );
}
