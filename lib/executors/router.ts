import "@/lib/server-only-runtime";

import { getCapability } from "@/lib/capability-registry";
import { ActivepiecesExecutor } from "@/lib/executors/activepieces";
import { ConnectorRunnerExecutor } from "@/lib/executors/connector-runner";
import {
  type CapabilityExecutor,
  type CapabilityExecutorSelection,
  DelegatedExecutionError,
} from "@/lib/executors/types";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";

type WorkflowStep = CompiledWorkflow["steps"][number];

/** Unpinned persisted workflows predate delegation and therefore remain native v1. */
export function resolveExecutorSelection(
  step: WorkflowStep,
  capabilityId: string,
): CapabilityExecutorSelection {
  const capability = getCapability(capabilityId);
  if (!capability) {
    throw new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
  }
  const selection = step.executor ?? { kind: "native" as const, capabilityVersion: 1 };
  if (capability.executorVersions[selection.capabilityVersion] !== selection.kind) {
    throw new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
  }
  return selection;
}

export function resolveExecutor(
  selection: CapabilityExecutorSelection,
): CapabilityExecutor | null {
  if (selection.kind === "native") return null;
  if (selection.kind === "activepieces") return new ActivepiecesExecutor();
  if (selection.kind === "connector_runner") return new ConnectorRunnerExecutor();
  throw new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
}
