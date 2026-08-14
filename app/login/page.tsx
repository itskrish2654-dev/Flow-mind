import type { Metadata } from "next";

import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Log in",
  robots: { index: false, follow: false },
};

function safeNextPath(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.startsWith("/dashboard") || candidate?.startsWith("/settings") ? candidate : "/dashboard";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[]; notice?: string | string[]; recover?: string | string[]; mode?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextPath = safeNextPath(params.next);

  return (
    <main className="dashboard-theme relative flex min-h-dvh items-center justify-center overflow-y-auto bg-[#f7f4ee] px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_12%,rgba(241,201,75,.2),transparent_34%)]" />
      <div className="relative">
        <LoginForm
          nextPath={nextPath}
          turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null}
          initialMessage={Array.isArray(params.error) ? params.error[0] : params.error}
          notice={Array.isArray(params.notice) ? params.notice[0] : params.notice}
          initialMode={(Array.isArray(params.recover) ? params.recover[0] : params.recover) === "1" ? "recovery" : (Array.isArray(params.mode) ? params.mode[0] : params.mode) === "signup" ? "signup" : "login"}
        />
        <nav aria-label="Legal and support" className="mt-5 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          <a href="/privacy" className="hover:text-slate-900">Privacy</a>
          <a href="/terms" className="hover:text-slate-900">Terms</a>
          <a href="/security" className="hover:text-slate-900">Security</a>
          <a href="/data-use" className="hover:text-slate-900">Data use</a>
          <a href="/support" className="hover:text-slate-900">Support</a>
        </nav>
        <p className="mt-2 text-center text-[10px] text-slate-400">Protected by Supabase Auth, Turnstile, and row-level security</p>
      </div>
    </main>
  );
}
