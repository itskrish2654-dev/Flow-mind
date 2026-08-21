import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConnectorRunnerExecutor } from "@/lib/executors/connector-runner";

const CONFIRMATION = "RUN_FAKE_D16_CANARY_ONLY";

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  if (process.env.D16_CANARY_CONFIRM !== CONFIRMATION) {
    fail(`Set D16_CANARY_CONFIRM=${CONFIRMATION} to run the fake canary.`);
  }

  const runnerUrl = process.env.CONNECTOR_RUNNER_URL ?? "";
  let parsedRunnerUrl: URL;
  try {
    parsedRunnerUrl = new URL(runnerUrl);
  } catch {
    fail("CONNECTOR_RUNNER_URL is invalid.");
  }
  if (
    parsedRunnerUrl.protocol !== "https:" ||
    parsedRunnerUrl.pathname !== "/v1/execute" ||
    runnerUrl === process.env.ACTIVEPIECES_BRIDGE_URL
  ) {
    fail("The canary requires the dedicated HTTPS Connector Runner endpoint.");
  }

  const canary = `CRAZYLOOPS_CANARY_${randomBytes(48).toString("hex")}`;
  const controlDirectory = await mkdtemp(join(tmpdir(), "crazyloops-d16-control-"));
  const controlFile = join(controlDirectory, "canary-pattern.txt");
  await writeFile(controlFile, `${canary}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(controlFile, 0o600);

  const credential = Buffer.from(canary, "utf8");
  const requestId = randomUUID();
  const executionId = randomUUID();
  const workflowVersionId = randomUUID();
  const ownerId = randomUUID();
  const stepId = "d16_runner_canary";
  const expectedProof = createHmac("sha256", credential)
    .update("CrazyLoops runner proof")
    .digest("hex");

  try {
    const executor = new ConnectorRunnerExecutor({
      resolveCredential: async () => credential,
      captureTelemetry: async () => undefined,
    });
    const result = await executor.execute({
      authenticatedUserId: ownerId,
      workflowOwnerId: ownerId,
      envelope: {
        protocolVersion: 1,
        requestId,
        executionId,
        workflowVersionId,
        stepId,
        capabilityId: "internal.connector_runner_canary",
        capabilityVersion: 1,
        mode: "TEST",
        idempotencyKey: `${executionId}:${stepId}:v1`,
        input: { simulation: "success" },
      },
    });
    if (!result.ok || result.output.proof !== expectedProof) {
      fail("The Connector Runner canary did not return the expected proof.");
    }
    console.info(JSON.stringify({
      status: "success",
      requestId,
      executionId,
      workflowVersionId,
      stepId,
      controlFile,
      plaintextPrinted: false,
    }));
  } finally {
    credential.fill(0);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The D1.6 canary failed.");
  process.exitCode = 1;
});
