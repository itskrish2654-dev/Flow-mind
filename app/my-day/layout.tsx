import type { Metadata } from "next";

import DashboardLayout from "@/app/dashboard/layout";

export const metadata: Metadata = {
  title: "My Day",
  description: "See what needs your attention and what you can move forward in CrazyLoops.",
  robots: { index: false, follow: false },
};

export default function MyDayLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
