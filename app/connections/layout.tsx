import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SettingsShell } from "@/components/settings-shell";
import { listCurrentUserWorkspaces } from "@/lib/company";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Connections",
  robots: { index: false, follow: false },
};

export default async function ConnectionsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/connections");
  const workspaces = await listCurrentUserWorkspaces();
  return <SettingsShell workspaces={workspaces}>{children}</SettingsShell>;
}
