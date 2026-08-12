import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SettingsShell } from "@/components/settings-shell";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Account settings | FlowMind",
  robots: { index: false, follow: false },
};

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");
  return <SettingsShell>{children}</SettingsShell>;
}
