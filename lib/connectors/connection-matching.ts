export type ConnectorConnectionIdentity = {
  id: string;
  user_id: string;
  connector_id: string;
  provider_family: string;
  status: string;
};

export type ConnectorManifestIdentity = {
  id: string;
  providerFamily: string;
};

export function connectorConnectionIds(manifest: ConnectorManifestIdentity): string[] {
  return Array.from(new Set([manifest.id, manifest.providerFamily]));
}

export function matchesOwnedConnectionIdentity(input: {
  connection: ConnectorConnectionIdentity | null | undefined;
  authenticatedUserId: string;
  connectionId: string;
}): input is {
  connection: ConnectorConnectionIdentity;
  authenticatedUserId: string;
  connectionId: string;
} {
  const { connection, authenticatedUserId, connectionId } = input;
  return Boolean(
    connection &&
    connection.id === connectionId &&
    connection.user_id === authenticatedUserId &&
    connection.status === "connected",
  );
}

export function matchesConnectorManifest(
  connection: ConnectorConnectionIdentity,
  manifest: ConnectorManifestIdentity,
): boolean {
  return connection.provider_family === manifest.providerFamily &&
    connectorConnectionIds(manifest).includes(connection.connector_id);
}

export function matchesOwnedConnectorConnection(input: {
  connection: ConnectorConnectionIdentity | null | undefined;
  authenticatedUserId: string;
  connectionId: string;
  manifest: ConnectorManifestIdentity;
}): input is {
  connection: ConnectorConnectionIdentity;
  authenticatedUserId: string;
  connectionId: string;
  manifest: ConnectorManifestIdentity;
} {
  return matchesOwnedConnectionIdentity(input) &&
    matchesConnectorManifest(input.connection, input.manifest);
}
