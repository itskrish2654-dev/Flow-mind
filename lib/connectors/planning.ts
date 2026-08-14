import type { ConnectorManifest, ConnectorOperation } from "@/lib/connectors/types";

export const CONNECTOR_PLANNING_STATUSES = ["SUPPORTED", "CONNECTION_REQUIRED", "ADDITIONAL_SCOPE_REQUIRED", "UNSUPPORTED"] as const;
export type ConnectorPlanningStatus = (typeof CONNECTOR_PLANNING_STATUSES)[number];

export type ConnectionSummary = { id?: string; connectorId: string; providerFamily?: string; status: "connected" | "expired" | "revoked" | "error"; grantedScopes: string[] };

export function assessConnectorPlan(manifest: ConnectorManifest | null, operation: ConnectorOperation | null, connections: ConnectionSummary[], mode: "test" | "production", selectedConnectionId?: string) {
  if (!manifest || !operation || manifest.status === "COMING_SOON" || manifest.status === "INTERNAL" && mode === "production" || (mode === "production" ? !operation.production : !operation.testMode)) {
    return { status: "UNSUPPORTED" as const, missingScopes: [], message: "This connector operation is not currently supported." };
  }
  if (!operation.connectionRequired) return { status: "SUPPORTED" as const, missingScopes: [], message: "This connector operation is available." };
  const candidates = connections.filter((item) => (item.connectorId === manifest.id || item.providerFamily === manifest.providerFamily) && item.status === "connected");
  if (candidates.length > 1 && !selectedConnectionId) return { status: "CONNECTION_REQUIRED" as const, missingScopes: operation.requiredScopes, message: `Choose which ${manifest.providerFamily === "google" ? "Google account" : manifest.displayName} this workflow should use.` };
  const connection = selectedConnectionId ? candidates.find((item) => item.id === selectedConnectionId) : candidates[0];
  if (!connection) return { status: "CONNECTION_REQUIRED" as const, missingScopes: operation.requiredScopes, message: `Connect ${manifest.displayName} before using this operation.` };
  const missingScopes = operation.requiredScopes.filter((scope) => !connection.grantedScopes.includes(scope));
  if (missingScopes.length) return { status: "ADDITIONAL_SCOPE_REQUIRED" as const, missingScopes, message: `Reconnect ${manifest.displayName} to approve the required access.` };
  return { status: "SUPPORTED" as const, missingScopes: [], message: "This connector operation is available." };
}
