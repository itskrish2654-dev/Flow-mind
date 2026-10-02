import type { Metadata } from "next";

import DashboardLayout from "@/app/dashboard/layout";

export const metadata: Metadata = {
  title: "Company Knowledge",
  description: "Workspace-shared documents used as grounded Ask CrazyLoops sources.",
  robots: { index: false, follow: false },
};

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
