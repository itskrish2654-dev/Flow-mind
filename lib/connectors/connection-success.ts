/** A redirect hint is not proof that a connector-specific grant was saved. */
export function matchesConnectorSuccess(
  connectorId: string | null,
  connection: {
    provider: string;
    providerName: string;
    status: string;
    sheetsAccess?: boolean;
    calendarAccess?: boolean;
  },
): boolean {
  if (!connectorId || connection.status !== "connected") return false;
  if (connectorId === "google_gmail") {
    return connection.provider === "google" && connection.providerName === "Gmail";
  }
  if (connectorId === "google_sheets") {
    return connection.provider === "google" && connection.sheetsAccess === true;
  }
  if (connectorId === "google_calendar") {
    return connection.provider === "google" && connection.calendarAccess === true;
  }
  if (connectorId === "google") return connection.provider === "google";
  return connection.provider === connectorId;
}
