import Link from "next/link";
import { Gauge, KeyRound, Mail, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { AccountControls } from "@/components/account-controls";
import { createClient } from "@/lib/supabase/server";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");
  const memberSince = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(user.created_at));

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#8a6200]">Account</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Settings</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">Manage your security, data, usage, and account lifecycle.</p>
      <div className="mt-8 grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-5">
          <section className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6">
            <h2 className="text-base font-semibold text-slate-950">Account details</h2>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl bg-[#faf8f4] p-4"><dt className="flex items-center gap-2 text-xs font-semibold text-slate-500"><Mail className="size-3.5" />Email</dt><dd className="mt-2 break-all text-sm font-medium text-slate-900">{user.email}</dd></div>
              <div className="rounded-xl bg-[#faf8f4] p-4"><dt className="flex items-center gap-2 text-xs font-semibold text-slate-500"><ShieldCheck className="size-3.5" />Member since</dt><dd className="mt-2 text-sm font-medium text-slate-900">{memberSince}</dd></div>
            </dl>
          </section>
          <AccountControls turnstileSiteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null} />
        </div>
        <aside className="space-y-3">
          <Link href="/settings/usage" className="flex items-start gap-3 rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-4 hover:border-[#d7aa2f]"><Gauge className="mt-0.5 size-5 text-[#8a6200]" /><span><span className="block text-sm font-semibold text-slate-950">Usage and limits</span><span className="mt-1 block text-xs leading-5 text-slate-500">See current monthly usage.</span></span></Link>
          <Link href="/settings#session" className="flex items-start gap-3 rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-4 hover:border-[#d7aa2f]"><KeyRound className="mt-0.5 size-5 text-[#8a6200]" /><span><span className="block text-sm font-semibold text-slate-950">Password and session</span><span className="mt-1 block text-xs leading-5 text-slate-500">Open recovery or log out.</span></span></Link>
        </aside>
      </div>
    </div>
  );
}
