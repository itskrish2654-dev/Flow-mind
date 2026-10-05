/** A temporary, fail-closed exception for live Sheets acceptance on the isolated staging stack. */
type GoogleSheetsAcceptanceEnvironment = {
  NODE_ENV?: string;
  GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED?: string;
  NEXT_PUBLIC_SITE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
};

export function googleSheetsLiveAcceptanceEnabled(env: GoogleSheetsAcceptanceEnvironment = process.env): boolean {
  return env.GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED === "true"
    && env.NEXT_PUBLIC_SITE_URL === "https://staging.crazy-loops.com"
    && env.NEXT_PUBLIC_SUPABASE_URL === "https://gamdxwtgccluifatcrrs.supabase.co";
}

export function googleSheetsAcceptanceConnector(connectorId: string): boolean {
  return connectorId === "google_sheets" && googleSheetsLiveAcceptanceEnabled();
}

export function googleSheetsAcceptanceCapability(capabilityId: string): boolean {
  return (capabilityId === "google_sheets_find_row"
    || capabilityId === "google_sheets_add_row"
    || capabilityId === "google_sheets_update_row")
    && googleSheetsLiveAcceptanceEnabled();
}
