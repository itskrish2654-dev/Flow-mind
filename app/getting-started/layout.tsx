import type { Metadata } from "next";

import DashboardLayout from "@/app/dashboard/layout";

export const metadata: Metadata = {
  title: "Getting started | CrazyLoops",
  robots: { index: false, follow: false },
};

export default function GettingStartedLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
