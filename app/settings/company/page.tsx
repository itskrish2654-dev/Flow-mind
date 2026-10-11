import { redirect } from "next/navigation";
import { Building2 } from "lucide-react";
import Link from "next/link";

import { CompanyAdmin } from "@/components/company-admin";
import { getCompanyAdministration } from "@/lib/company";

export default async function CompanySettingsPage() {
  let company;
  try { company = await getCompanyAdministration(); } catch { redirect("/my-day"); }
  return <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#8a6200]">Company</p><h1 className="mt-2 flex items-center gap-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950"><Building2 className="size-7 text-[#8a6200]" />Workspace settings</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Manage the company name, teammates, roles, and secure invitations.</p><Link href="/getting-started" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[#4b357d] underline underline-offset-4">Back to getting started</Link><div className="mt-6"><CompanyAdmin workspaceName={company.workspace.name} currentRole={company.currentRole} members={company.members} invitations={company.invitations} /></div></div>;
}
