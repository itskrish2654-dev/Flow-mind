import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ResetPasswordForm } from "@/components/reset-password-form";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Reset password | FlowMind",
  robots: { index: false, follow: false },
};

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?error=recovery_failed");

  return (
    <main className="dashboard-theme flex min-h-dvh items-center justify-center overflow-y-auto bg-[#f7f4ee] px-5 py-10">
      <ResetPasswordForm />
    </main>
  );
}
