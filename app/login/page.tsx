import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { createClient } from "@/lib/supabase/server";

function safeNextPath(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate?.startsWith("/dashboard") ? candidate : "/dashboard";
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const [params, supabase] = await Promise.all([searchParams, createClient()]);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const nextPath = safeNextPath(params.next);
  if (user) redirect(nextPath);

  return (
    <main className="dashboard-theme relative flex min-h-dvh items-center justify-center overflow-y-auto bg-[#f7f4ee] px-5 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_12%,rgba(241,201,75,.2),transparent_34%)]" />
      <div className="relative"><LoginForm nextPath={nextPath} turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null} /><p className="mt-5 text-center text-[10px] text-slate-400">Protected by Supabase Auth, Turnstile, and row-level security</p></div>
    </main>
  );
}
