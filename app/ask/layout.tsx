import type { Metadata } from "next";

import DashboardLayout from "@/app/dashboard/layout";

export const metadata: Metadata = {
  title: "Ask CrazyLoops",
  description: "Ask about your current CrazyLoops work, approvals, workflows, and recent activity.",
  robots: { index: false, follow: false },
};

export default function AskLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
