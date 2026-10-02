import type { Metadata } from "next";

import DashboardLayout from "@/app/dashboard/layout";

export const metadata: Metadata = {
  title: "Activity",
  description: "See what CrazyLoops prepared, approved, executed, and confirmed.",
  robots: { index: false, follow: false },
};

export default function ActivityLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
