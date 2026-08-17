import { cookies } from "next/headers";

import { AutomationWorkspace } from "@/components/automation-workspace";
import { getAuthenticatedContext } from "@/lib/auth";
import { listConnectionViews } from "@/lib/connectors/connection-view";
import { trackProductEvent } from "@/lib/observability";
import {
  HOMEPAGE_DEMO_DRAFT_COOKIE,
  openHomepageDemoDraft,
} from "@/lib/security/homepage-demo-draft";

export default async function DashboardPage() {
  const auth = await getAuthenticatedContext();
  if (auth) await trackProductEvent({ event: "dashboard_viewed", userId: auth.user.id });
  const connections = auth ? await listConnectionViews(auth.user.id) : [];
  const cookieStore = await cookies();
  const draftToken = cookieStore.get(HOMEPAGE_DEMO_DRAFT_COOKIE)?.value;
  const initialPrompt = draftToken ? openHomepageDemoDraft(draftToken) : null;
  return (
    <AutomationWorkspace
      initialPrompt={initialPrompt ?? ""}
      initialDraftReady={Boolean(initialPrompt)}
      initialConnections={connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        providerName: connection.providerName,
        accountLabel: connection.accountLabel,
        status: connection.status,
      }))}
    />
  );
}
