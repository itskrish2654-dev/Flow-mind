import "@/lib/server-only-runtime";

import { getCapability } from "@/lib/capability-registry";
import { getConnector } from "@/lib/connectors/registry";
import type { ConnectorOperation, RegisteredConnector } from "@/lib/connectors/types";
import {
  isDeferredCustomerAirtableConnection,
  isVerifiedCustomerAirtableCreateRecordConnection,
} from "@/lib/connectors/airtable/workflow-configuration";
import { matchesConnectorManifest, matchesOwnedConnectionIdentity } from "@/lib/connectors/connection-matching";

export const DELEGATED_CREDENTIAL_ERROR_CATEGORIES = [
  "DELEGATED_CREDENTIAL_AUTH_FAILED",
  "DELEGATED_CREDENTIAL_CONNECTION_UNAVAILABLE",
  "DELEGATED_CREDENTIAL_CONNECTOR_MISMATCH",
  "DELEGATED_CREDENTIAL_SCOPE_MISSING",
  "DELEGATED_CREDENTIAL_MISSING",
  "DELEGATED_CREDENTIAL_UNSUPPORTED",
] as const;

export type DelegatedCredentialErrorCategory =
  (typeof DELEGATED_CREDENTIAL_ERROR_CATEGORIES)[number];

export class DelegatedCredentialError extends Error {
  readonly category: DelegatedCredentialErrorCategory;

  constructor(category: DelegatedCredentialErrorCategory) {
    super("This connection cannot authorize the delegated step.");
    this.name = "DelegatedCredentialError";
    this.category = category;
  }
}

export type DelegatedCredentialProjection =
  | { kind: "oauth2_bearer"; value: string }
  | { kind: "api_key"; value: string };

export type ResolveDelegatedCredentialInput = {
  authenticatedUserId: string;
  workflowOwnerId: string;
  connectionId: string;
  connectorId: string;
  capabilityId: string;
  executionMode?: "TEST" | "LIVE";
};

type ConnectionRecord = {
  id: string;
  user_id: string;
  connector_id: string;
  provider_family: string;
  auth_type: "none" | "api_key" | "oauth2";
  status: "connected" | "expired" | "revoked" | "error";
  granted_scopes: string[];
  safe_metadata?: unknown;
};

type StoredConnectionCredential = {
  credentialType: string;
  plaintext: string;
};

export type DelegatedCredentialResolverDependencies = {
  loadOwnedConnection(input: {
    userId: string;
    connectionId: string;
  }): Promise<ConnectionRecord | null>;
  readCredential(input: {
    userId: string;
    connectionId: string;
    credentialKey: string;
  }): Promise<StoredConnectionCredential>;
};

type ConnectorCapability = {
  connector: RegisteredConnector;
  operation: ConnectorOperation;
};

const CONNECTOR_IMPLEMENTATION = /^connector:([a-z][a-z0-9_]{2,79})\/([a-z][a-z0-9_]{1,79})@(\d+)$/;

function connectorCapability(capabilityId: string, connectorId: string): ConnectorCapability {
  const capability = getCapability(capabilityId);
  if (
    !capability?.supported ||
    !capability.credentialsRequired ||
    !capability.executionImplementation
  ) {
    throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_UNSUPPORTED");
  }

  const implementation = CONNECTOR_IMPLEMENTATION.exec(capability.executionImplementation);
  if (!implementation || implementation[1] !== connectorId) {
    throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_CONNECTOR_MISMATCH");
  }

  const connector = getConnector(connectorId);
  const operationKey = implementation[2];
  const operationVersion = Number(implementation[3]);
  const operation = connector
    ? [...connector.manifest.triggers, ...connector.manifest.actions]
        .find((candidate) => candidate.key === operationKey && candidate.version === operationVersion)
    : undefined;
  if (!connector || !operation?.connectionRequired) {
    throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_UNSUPPORTED");
  }
  return { connector, operation };
}

function credentialRequirement(authType: ConnectionRecord["auth_type"]): {
  key: string;
  storedType: string;
  projectionKind: DelegatedCredentialProjection["kind"];
} {
  if (authType === "oauth2") {
    return {
      key: "access_token",
      storedType: "oauth_access_token",
      projectionKind: "oauth2_bearer",
    };
  }
  if (authType === "api_key") {
    return { key: "api_key", storedType: "api_key", projectionKind: "api_key" };
  }
  throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_UNSUPPORTED");
}

const defaultDependencies: DelegatedCredentialResolverDependencies = {
  async loadOwnedConnection({ userId, connectionId }) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("connector_connections")
      .select("id,user_id,connector_id,provider_family,auth_type,status,granted_scopes,safe_metadata")
      .eq("id", connectionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_CONNECTION_UNAVAILABLE");
    }
    return data;
  },
  async readCredential(input) {
    const { readConnectionCredential } = await import("@/lib/connectors/connection-vault");
    return readConnectionCredential(input);
  },
};

export function createDelegatedCredentialResolver(
  dependencies: DelegatedCredentialResolverDependencies,
) {
  return async function resolveDelegatedCredentialWithDependencies(
    input: ResolveDelegatedCredentialInput,
  ): Promise<DelegatedCredentialProjection> {
    if (
      !input.authenticatedUserId ||
      !input.workflowOwnerId ||
      input.authenticatedUserId !== input.workflowOwnerId
    ) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_AUTH_FAILED");
    }

    const { connector, operation } = connectorCapability(input.capabilityId, input.connectorId);
    const connection = await dependencies.loadOwnedConnection({
      userId: input.authenticatedUserId,
      connectionId: input.connectionId,
    });
    if (!connection || !matchesOwnedConnectionIdentity({
      connection,
      authenticatedUserId: input.authenticatedUserId,
      connectionId: input.connectionId,
    })) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_CONNECTION_UNAVAILABLE");
    }
    if (!matchesConnectorManifest(connection, connector.manifest) || connection.auth_type !== connector.manifest.auth.type) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_CONNECTOR_MISMATCH");
    }

    const capability = getCapability(input.capabilityId);
    if (
      input.executionMode === "LIVE" &&
      (!capability?.availableInProduction || !operation.production)
    ) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_UNSUPPORTED");
    }
    if (
      input.executionMode === "TEST" &&
      (!capability?.availableInTest || !operation.testMode)
    ) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_UNSUPPORTED");
    }
    if (
      input.executionMode === "LIVE" &&
      input.capabilityId === "airtable.create_record" &&
      !isVerifiedCustomerAirtableCreateRecordConnection(connection)
    ) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_SCOPE_MISSING");
    }

    const missingScope = operation.requiredScopes.some(
      (scope) => !connection.granted_scopes.includes(scope),
    );
    const deferredAirtable = input.executionMode === "TEST" &&
      input.capabilityId === "airtable.create_record" &&
      input.connectorId === "airtable" &&
      operation.key === "create_record" &&
      operation.version === 1 &&
      isDeferredCustomerAirtableConnection(connection);
    if (missingScope && !deferredAirtable) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_SCOPE_MISSING");
    }

    const requirement = credentialRequirement(connection.auth_type);
    let credential: StoredConnectionCredential;
    try {
      credential = await dependencies.readCredential({
        userId: input.authenticatedUserId,
        connectionId: connection.id,
        credentialKey: requirement.key,
      });
    } catch {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_MISSING");
    }
    if (credential.credentialType !== requirement.storedType || !credential.plaintext) {
      throw new DelegatedCredentialError("DELEGATED_CREDENTIAL_MISSING");
    }

    return requirement.projectionKind === "oauth2_bearer"
      ? { kind: "oauth2_bearer", value: credential.plaintext }
      : { kind: "api_key", value: credential.plaintext };
  };
}

export const resolveDelegatedCredential = createDelegatedCredentialResolver(defaultDependencies);
