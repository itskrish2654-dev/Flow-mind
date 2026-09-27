import { redirect } from "next/navigation";

import { MyDayView } from "@/components/my-day/my-day-view";
import { loadMyDayData } from "@/lib/my-day";

export default async function MyDayPage({ searchParams }: { searchParams: Promise<{ work_item_error?: string; approval_error?: string }> }) {
  const data = await loadMyDayData();
  if (!data) redirect("/login?next=/my-day");
  const { work_item_error: workItemError, approval_error: approvalError } = await searchParams;
  return <MyDayView data={data} actionError={workItemError === "update_failed"} approvalActionError={approvalError === "decision_failed"} />;
}
