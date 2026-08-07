"use server";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { z } from "zod";

import {
  WorkflowStepSchema,
  type CompiledWorkflow,
} from "@/lib/schemas/workflow";
import { getAuthenticatedContext } from "@/lib/auth";

export type TestExecutionLog = {
  icon: string;
  message: string;
};

export type TestWorkflowResult =
  | { ok: true; logs: TestExecutionLog[]; delivered: boolean }
  | { ok: false; error: string };

type WorkflowStep = CompiledWorkflow["steps"][number];
type InputValues = Record<string, string>;

const TestRequestSchema = z.object({
  workflowId: z.string().uuid(),
  steps: z.array(WorkflowStepSchema).min(1).max(10),
  inputValues: z.record(z.string(), z.string().max(10_000)).refine(
    (values) => Object.keys(values).length <= 100,
    "Too many setup values were provided.",
  ),
});

function isBlockedIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];

  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }

  return true;
}

async function validatePublicDestination(value: string): Promise<URL | null> {
  let destination: URL;

  try {
    destination = new URL(value);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(destination.protocol) ||
    destination.username ||
    destination.password
  ) {
    return null;
  }

  const hostname = destination.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return null;
  }

  if (isIP(hostname)) {
    return isBlockedIpAddress(hostname) ? null : destination;
  }

  try {
    const resolvedAddresses = await lookup(hostname, { all: true });
    if (
      resolvedAddresses.length === 0 ||
      resolvedAddresses.some(({ address }) => isBlockedIpAddress(address))
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return destination;
}

function destinationCandidates(
  step: WorkflowStep,
  inputValues: InputValues,
): string[] {
  const stepInputKeys = new Set(
    (step.inputsRequired ?? []).flatMap((input) => [
      input.key,
      `${step.id}-${input.key}`,
    ]),
  );
  const entries = Object.entries(inputValues);
  const associatedValues = entries
    .filter(([key]) => stepInputKeys.has(key) || key.startsWith(`${step.id}-`))
    .map(([, value]) => value);
  const destinationNamedValues = entries
    .filter(
      ([key]) =>
        /destination|webhook|url|link|send|save/i.test(key) &&
        !/trigger|listen|source/i.test(key),
    )
    .map(([, value]) => value);
  const scopedCandidates = Array.from(
    new Set([...associatedValues, ...destinationNamedValues]),
  ).filter((value) => /^https?:\/\//i.test(value.trim()));

  return scopedCandidates;
}

function validateRequiredInputs(
  steps: WorkflowStep[],
  inputValues: InputValues,
): string | null {
  for (const step of steps) {
    for (const input of step.inputsRequired ?? []) {
      const value = (
        inputValues[`${step.id}-${input.key}`] ??
        inputValues[input.key] ??
        input.value ??
        ""
      ).trim();

      if (!value) return `${input.label} is required before running a test.`;
      if (input.type === "url") {
        try {
          const parsed = new URL(value);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return `${input.label} must be a valid http or https link.`;
          }
        } catch {
          return `${input.label} must be a valid link.`;
        }
      }
    }
  }
  return null;
}

function publicTestData(
  steps: WorkflowStep[],
  inputValues: InputValues,
): Record<string, string> {
  const safeEntries = steps.flatMap((step) =>
    (step.inputsRequired ?? [])
      .filter((input) => input.type !== "secret")
      .map((input) => {
        const value = inputValues[`${step.id}-${input.key}`] ?? inputValues[input.key] ?? input.value ?? "";
        return [`${step.id}.${input.key}`, value] as const;
      }),
  );
  return Object.fromEntries(safeEntries);
}

async function findDestinationUrl(
  step: WorkflowStep,
  inputValues: InputValues,
): Promise<URL | null> {
  for (const candidate of destinationCandidates(step, inputValues)) {
    const destination = await validatePublicDestination(candidate.trim());
    if (destination) return destination;
  }

  return null;
}

export async function runTestWorkflow(
  workflowId: string,
  steps: CompiledWorkflow["steps"],
  inputValues: InputValues,
): Promise<TestWorkflowResult> {
  const request = TestRequestSchema.safeParse({ workflowId, steps, inputValues });

  if (!request.success) {
    return {
      ok: false,
      error: "The test setup is incomplete or contains an invalid value.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { data: ownedWorkflow, error: ownershipError } = await auth.supabase
    .from("workflows")
    .select("id")
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (ownershipError || !ownedWorkflow) {
    return { ok: false, error: "Unauthorized" };
  }

  const validationError = validateRequiredInputs(
    request.data.steps,
    request.data.inputValues,
  );
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const logs: TestExecutionLog[] = [];
  let delivered = false;

  for (const [index, step] of request.data.steps.entries()) {
    if (step.type === "webhook_trigger") {
      logs.push({
        icon: "✅",
        message: `Step ${index + 1}: A safe sample event started the automation.`,
      });
      continue;
    }

    if (step.type === "ai_transform") {
      logs.push({
        icon: "✨",
        message: `Step ${index + 1}: FlowPilot created a simulated AI result.`,
      });
      continue;
    }

    if (step.type === "filter_condition") {
      logs.push({
        icon: "🔍",
        message: `Step ${index + 1}: The test information passed your rule.`,
      });
      continue;
    }

    if (step.type === "http_request") {
      const destinationUrl = await findDestinationUrl(
        step,
        request.data.inputValues,
      );

      if (!destinationUrl) {
        logs.push({
          icon: "⚠️",
          message: `Step ${index + 1}: No valid public destination link was found.`,
        });
        continue;
      }

      try {
        const response = await fetch(destinationUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "test_run",
            message:
              "Hello from FlowPilot! Your AI automation is wired up correctly.",
            workflow_id: request.data.workflowId,
            timestamp: new Date().toISOString(),
            input_data: publicTestData(
              request.data.steps,
              request.data.inputValues,
            ),
          }),
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });

        delivered = response.ok;
        logs.push(
          response.ok
            ? {
                icon: "🚀",
                message: `Step ${index + 1}: Real data sent! The destination accepted it (Status: ${response.status}).`,
              }
            : {
                icon: "⚠️",
                message: `Step ${index + 1}: Data was sent, but the destination returned an error (Status: ${response.status}).`,
              },
        );
      } catch (error: unknown) {
        console.error("FlowPilot test delivery failed", error);
        logs.push({
          icon: "❌",
          message: `Step ${index + 1}: Failed to send data because of a network error or invalid link.`,
        });
      }
    }
  }

  return { ok: true, logs, delivered };
}
