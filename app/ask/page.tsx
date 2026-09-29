import { redirect } from "next/navigation";

import { AskView } from "@/components/ask/ask-view";
import { loadAskPageData } from "@/lib/ask";

export default async function AskPage({ searchParams }: {
  searchParams: Promise<{ thread?: string; request?: string }>;
}) {
  const { thread, request } = await searchParams;
  const data = await loadAskPageData(thread, request);
  if (!data) redirect("/login?next=/ask");
  return <AskView key={`${data.selectedThread?.id ?? "new"}:${data.requestedSubmissionId ?? "none"}`} data={data} />;
}
