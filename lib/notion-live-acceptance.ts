/** Keep Notion OAuth available only on the isolated live-acceptance stack. */
type NotionAcceptanceEnvironment = {
  NODE_ENV?: string;
  CRAZYLOOPS_DEPLOYMENT_ROLE?: string;
  NEXT_PUBLIC_SITE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  FLOWMIND_CONNECTOR_NOTION_CLIENT_ID?: string;
  FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET?: string;
};

export function notionLiveAcceptanceEnabled(env: NotionAcceptanceEnvironment = process.env): boolean {
  return env.CRAZYLOOPS_DEPLOYMENT_ROLE === "staging"
    && env.NEXT_PUBLIC_SITE_URL === "https://staging.crazy-loops.com"
    && env.NEXT_PUBLIC_SUPABASE_URL === "https://gamdxwtgccluifatcrrs.supabase.co"
    && Boolean(env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID?.trim())
    && Boolean(env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET?.trim());
}

export function notionAcceptanceConnector(connectorId: string): boolean {
  return connectorId === "notion" && notionLiveAcceptanceEnabled();
}

/** Ask-only write acceptance; workflow/planner registry availability stays false. */
export function notionAcceptanceAction(capabilityId: string): boolean {
  return notionLiveAcceptanceEnabled()
    && (capabilityId === "notion_create_data_source_item" || capabilityId === "notion_update_item");
}
