import { redirect } from "next/navigation";

import { MyDayView } from "@/components/my-day/my-day-view";
import { listMyAutomationSuggestions } from "@/lib/automate-this";
import { loadMyDayData } from "@/lib/my-day";

export default async function MyDayPage({ searchParams }: { searchParams: Promise<{ work_item_error?: string; approval_error?: string }> }) {
  const [data, suggestions] = await Promise.all([loadMyDayData(), listMyAutomationSuggestions()]);
  if (!data) redirect("/login?next=/my-day");
  const { work_item_error: workItemError, approval_error: approvalError } = await searchParams;
  return <MyDayView data={data} automationSuggestions={(suggestions ?? []).filter((item) => item.status === "suggested").slice(0, 2)} actionError={workItemError === "update_failed"} approvalActionError={approvalError === "decision_failed"} />;
}
