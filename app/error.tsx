"use client";

import Link from "next/link";
import { useEffect } from "react";
import { RefreshCw, TriangleAlert, Zap } from "lucide-react";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("FlowMind page error", { digest: error.digest ?? "unavailable" });
  }, [error]);

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#f4f7fb] px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(99,102,241,.12),transparent_34%)]" />
      <section className="relative w-full max-w-md rounded-[28px] border border-slate-200 bg-white p-8 text-center shadow-[0_28px_90px_-45px_rgba(30,41,59,.35)]">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-200">
          <Zap className="size-5 fill-current" />
        </span>
        <span className="mx-auto mt-8 flex size-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
          <TriangleAlert className="size-6" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.035em] text-slate-950">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Your work is still safe. Try loading this screen again or return to
          your automations.
        </p>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={retry}
            className="flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition hover:brightness-110"
          >
            <RefreshCw className="size-4" />
            Try again
          </button>
          <Link
            href="/dashboard"
            className="flex h-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
          >
            My automations
          </Link>
        </div>
      </section>
    </main>
  );
}
