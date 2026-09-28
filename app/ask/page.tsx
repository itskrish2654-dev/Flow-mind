import { redirect } from "next/navigation";

import { AskView } from "@/components/ask/ask-view";
import { loadAskPageData } from "@/lib/ask";

export default async function AskPage({ searchParams }: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const { thread } = await searchParams;
  const data = await loadAskPageData(thread);
  if (!data) redirect("/login?next=/ask");
  return <AskView data={data} />;
}
