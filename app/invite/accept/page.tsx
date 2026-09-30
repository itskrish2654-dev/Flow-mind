import Link from "next/link";
import { redirect } from "next/navigation";

import { InviteAcceptance } from "@/components/invite-acceptance";
import { previewCompanyInvitation } from "@/lib/company";
import { createClient } from "@/lib/supabase/server";

export default async function InviteAcceptPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const params = await searchParams;
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const preview = token ? await previewCompanyInvitation(token) : { status: "unavailable" as const };
  if (!token || preview.status === "unavailable" || preview.status === "revoked" || preview.status === "expired") {
    return <main className="dashboard-theme flex min-h-dvh items-center justify-center bg-[#f7f4ee] px-5"><div className="max-w-md rounded-3xl border border-[#ddd5c9] bg-[#fffdfa] p-8 text-center"><h1 className="text-2xl font-semibold text-slate-950">Invitation unavailable</h1><p className="mt-3 text-sm leading-6 text-slate-600">This invitation is invalid, expired, or has been revoked. Ask a company administrator for a new link.</p><Link href="/dashboard" className="mt-6 inline-flex rounded-xl bg-[#272536] px-5 py-3 text-sm font-semibold text-white">Open CrazyLoops</Link></div></main>;
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
  return <main className="dashboard-theme flex min-h-dvh items-center justify-center bg-[#f7f4ee] px-5 py-10"><InviteAcceptance token={token} workspaceName={preview.workspaceName} /></main>;
}
