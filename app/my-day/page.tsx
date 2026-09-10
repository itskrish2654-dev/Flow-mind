import { redirect } from "next/navigation";

import { MyDayView } from "@/components/my-day/my-day-view";
import { loadMyDayData } from "@/lib/my-day";

export default async function MyDayPage() {
  const data = await loadMyDayData();
  if (!data) redirect("/login?next=/my-day");
  return <MyDayView data={data} />;
}
