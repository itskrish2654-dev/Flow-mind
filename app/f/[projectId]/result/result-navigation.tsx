"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, House, Pause } from "lucide-react";
import { useEffect, useState } from "react";

const AUTO_RETURN_SECONDS = 12;

export function ResultNavigation({ formHref }: { formHref: string }) {
  const router = useRouter();
  const [secondsRemaining, setSecondsRemaining] = useState(AUTO_RETURN_SECONDS);
  const [autoReturnEnabled, setAutoReturnEnabled] = useState(true);

  useEffect(() => {
    if (!autoReturnEnabled) return;
    const timer = window.setInterval(() => {
      setSecondsRemaining((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [autoReturnEnabled]);

  useEffect(() => {
    if (autoReturnEnabled && secondsRemaining === 0) router.replace(formHref);
  }, [autoReturnEnabled, formHref, router, secondsRemaining]);

  return (
    <div className="mt-8">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:justify-center">
        <Link
          href={formHref}
          replace
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#d8cfae] bg-[#fff8dc] px-4 text-sm font-semibold text-[#725300] transition hover:bg-[#fff2bd] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9a7300]"
        >
          Submit another response <ArrowRight className="size-4" />
        </Link>
        <Link
          href="/"
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#ddd5c9] bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-[#f8f4ec] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
        >
          <House className="size-4" /> CrazyLoops home
        </Link>
      </div>

      {autoReturnEnabled ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
          <p>
            Returning to the form in <span aria-hidden="true">{secondsRemaining}</span>
            <span className="sr-only">about twelve seconds</span>…
          </p>
          <button
            type="button"
            onClick={() => setAutoReturnEnabled(false)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 font-semibold text-slate-700 underline decoration-slate-300 underline-offset-4 hover:text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500"
          >
            <Pause className="size-3.5" /> Stay on this page
          </button>
        </div>
      ) : (
        <p className="mt-5 text-[11px] text-slate-500">Automatic return paused.</p>
      )}
    </div>
  );
}
