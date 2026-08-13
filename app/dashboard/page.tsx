import { AutomationWorkspace } from "@/components/automation-workspace";
import { getAuthenticatedContext } from "@/lib/auth";
import { trackProductEvent } from "@/lib/observability";

export default async function DashboardPage() {
  const auth = await getAuthenticatedContext();
  if (auth) await trackProductEvent({ event: "dashboard_viewed", userId: auth.user.id });
  return <AutomationWorkspace />;
}
