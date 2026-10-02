import type { Metadata } from "next";

import DashboardLayout from "@/app/dashboard/layout";

export const metadata: Metadata = {
  title: "Goals | CrazyLoops",
  description: "Review company goals, approved plans and actual work progress.",
  robots: { index: false, follow: false },
};

export default function GoalsLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
