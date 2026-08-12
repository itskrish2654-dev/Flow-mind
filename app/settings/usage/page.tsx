import { redirect } from "next/navigation";

import { getAccountUsage } from "@/lib/account-usage";
import { createClient } from "@/lib/supabase/server";

function displayValue(metric: string, value: number) {
  if (metric === "storage_bytes") return `${(value / (1024 * 1024)).toFixed(value ? 1 : 0)} MB`;
  return value.toLocaleString();
}

export default async function UsagePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings/usage");
  let usage;
  try {
    usage = await getAccountUsage(user.id);
  } catch {
    return <section className="rounded-2xl border border-rose-200 bg-rose-50 p-6"><h1 className="text-xl font-semibold text-slate-950">Usage is temporarily unavailable</h1><p className="mt-2 text-sm text-slate-600">Please try again shortly. No internal service details were exposed.</p></section>;
  }

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#8a6200]">Free plan</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Usage and limits</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">Monthly counters reset at the start of each UTC month. Workflow and storage totals show current account data.</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {usage.map((item) => {
          const percentage = Math.min(100, (item.used / item.limit) * 100);
          return <section key={item.metric} className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5"><div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-semibold text-slate-950">{item.label}</h2><p className="text-xs font-medium text-slate-500">{displayValue(item.metric, item.used)} / {displayValue(item.metric, item.limit)}</p></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-[#eee9df]"><div className={`h-full rounded-full ${percentage >= 90 ? "bg-rose-500" : "bg-[#d7aa2f]"}`} style={{ width: `${percentage}%` }} /></div><p className="mt-3 text-[11px] text-slate-500">{item.monthly ? "Current month" : "Current total"}</p></section>;
        })}
      </div>
      <p className="mt-6 rounded-xl border border-[#e4ddd2] bg-[#faf8f4] px-4 py-3 text-xs text-slate-600">Additional plans are not yet available for purchase.</p>
    </div>
  );
}
