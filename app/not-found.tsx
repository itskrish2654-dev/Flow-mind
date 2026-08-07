import Link from "next/link";
import { ArrowLeft, SearchX, Zap } from "lucide-react";

export default function NotFound() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#f4f7fb] px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(99,102,241,.12),transparent_34%)]" />
      <section className="relative w-full max-w-md rounded-[28px] border border-slate-200 bg-white p-8 text-center shadow-[0_28px_90px_-45px_rgba(30,41,59,.35)]">
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-200">
          <Zap className="size-5 fill-current" />
        </span>
        <span className="mx-auto mt-8 flex size-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
          <SearchX className="size-6" />
        </span>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-indigo-600">
          Error 404
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-slate-950">
          This page does not exist
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          The link may be outdated, or the automation may have been removed.
        </p>
        <Link
          href="/dashboard"
          className="mt-7 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition hover:brightness-110"
        >
          <ArrowLeft className="size-4" />
          Back to my automations
        </Link>
      </section>
    </main>
  );
}
