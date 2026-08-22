import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { ActivepiecesExecutor } from "../lib/executors/activepieces";
import { ConnectorRunnerExecutor } from "../lib/executors/connector-runner";

const root = process.cwd();

test("D1/D1.6 cleanup removes every superseded D1.5 executable artifact", () => {
  for (const path of [
    ["lib", "executors", "delegated-capsule.ts"],
    ["scripts", "run-d15-canary-spike.ts"],
    ["docs", "activepieces", "crazyloops-bridge-worker-v2-canary-spike.json"],
    ["tests", "phase-d15-credential-capsule.test.ts"],
  ]) {
    assert.equal(existsSync(join(root, ...path)), false, path.join("/"));
  }

  const environment = readFileSync(join(root, ".env.example"), "utf8");
  assert.doesNotMatch(environment, /CRAZYLOOPS_DELEGATED_WRAP/);
  assert.match(environment, /^CONNECTOR_RUNNER_EXECUTION_ENABLED=false$/m);
  assert.match(environment, /^CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION=$/m);
  assert.match(environment, /^CONNECTOR_RUNNER_WRAP_KEY_V1=$/m);
});

test("D1 credential ownership and vault boundary remain the source of truth", () => {
  const source = readFileSync(
    join(root, "lib", "executors", "delegated-credentials.ts"),
    "utf8",
  );
  assert.match(source, /input\.authenticatedUserId !== input\.workflowOwnerId/);
  assert.match(source, /connection\.user_id !== input\.authenticatedUserId/);
  assert.match(source, /connection-vault/);
  assert.doesNotMatch(source, /delegated-capsule/);
});

test("Activepieces v1 and Connector Runner remain separate accepted executors", () => {
  assert.equal(new ActivepiecesExecutor().kind, "activepieces");
  assert.equal(new ConnectorRunnerExecutor().kind, "connector_runner");

  const bridge = readFileSync(
    join(root, "docs", "activepieces", "crazyloops-bridge-worker-v1.json"),
    "utf8",
  );
  assert.match(bridge, /internal\.bridge_echo/);
  assert.doesNotMatch(bridge, /credentialCapsule|protocolVersion:\s*2/);

  const canary = CAPABILITY_REGISTRY["internal.connector_runner_canary"];
  assert.equal(canary.internalOnly, true);
  assert.equal(canary.plannerVisible, false);
  assert.equal(canary.availableInProduction, false);
});

test("historical D1.5 documentation is truthful about the final boundary", () => {
  const history = readFileSync(
    join(root, "docs", "activepieces", "D15_CREDENTIAL_SAFE_ADAPTER_SPIKE.md"),
    "utf8",
  );
  assert.match(history, /SUPERSEDED \/ BLOCKED EXPERIMENT/);
  assert.match(history, /NOT PRODUCTION EXECUTION CODE/);
  assert.match(history, /FINAL CREDENTIAL PATH = CONNECTOR RUNNER/);
  assert.match(history, /Production Vercel-originated Connector Runner execution \| NOT YET ACCEPTED/);
  assert.match(history, /Real provider adapter \| NOT YET IMPLEMENTED/);
  assert.match(history, /plaintext canary occurrences \| `0`/i);
});
