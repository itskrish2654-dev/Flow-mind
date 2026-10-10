import type { Metadata } from "next";

import DashboardLayout from "@/app/dashboard/layout";

export const metadata: Metadata = {
  title: "Your automations | CrazyLoops",
  description: "Review repeated-work suggestions and the automations you control.",
  robots: { index: false, follow: false },
};

export default function AutomationsLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
