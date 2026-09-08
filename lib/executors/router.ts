import "@/lib/server-only-runtime";

import { resolveCapabilityImplementation } from "@/lib/capability-registry";
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
  const selection = step.executor ?? { kind: "native" as const, capabilityVersion: 1 };
  const implementation = resolveCapabilityImplementation(
    capabilityId,
    selection.capabilityVersion,
  );
  if (!implementation || implementation.version.executor !== selection.kind) {
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
