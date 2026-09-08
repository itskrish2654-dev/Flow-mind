import {
  CAPABILITY_REGISTRY,
  type CapabilityDefinition,
  type CapabilityConnectorOperation,
  validateCapabilityDefinitions,
} from "@/lib/capability-registry";
import { getConnectorOperation } from "@/lib/connectors/registry";

function connectorEvidence(operation: CapabilityConnectorOperation) {
  const registered = getConnectorOperation(
    operation.connectorId,
    operation.operationKind,
    operation.operationKey,
    operation.operationVersion,
  );
  if (!registered) return null;
  return {
    connectorId: registered.connector.manifest.id,
    providerFamily: registered.connector.manifest.providerFamily,
    authType: registered.connector.manifest.auth.type,
    operationKind: registered.operation.kind,
    operationKey: registered.operation.key,
    operationVersion: registered.operation.version,
    executor: registered.operation.executor ?? "native" as const,
    requiredScopes: registered.operation.requiredScopes,
    connectionRequired: registered.operation.connectionRequired,
    availableInTest: registered.operation.testMode,
    availableInProduction: registered.operation.production,
  };
}

/** Validates the product registry against the independently registered connector operations. */
export function validateCapabilityRegistry(
  definitions: readonly CapabilityDefinition[] = Object.values(CAPABILITY_REGISTRY),
): string[] {
  return validateCapabilityDefinitions(definitions, connectorEvidence);
}

export function assertCapabilityRegistryValid(): void {
  const errors = validateCapabilityRegistry();
  if (errors.length) {
    throw new Error(`Invalid capability registry: ${errors.join("; ")}`);
  }
}
