import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import {
  canaryPersistenceOccurrences,
  countRunningSandboxContainers,
  ensureSandboxImage,
  freshParentSentinels,
  imageEvidence,
  invokeRawSandboxForTest,
  invokeSandbox,
  invokeSandboxWithOverridesForTest,
  sandboxConstants,
  sandboxRuntimeAvailable,
  sandboxRuntimeDescription,
  type SandboxInvocation,
} from "../experiments/activepieces-piece-sandbox/harness";

const FALLBACK_REQUEST_ID = "00000000-0000-4000-8000-000000000000";
const runtimeAvailable = sandboxRuntimeAvailable();
const invocations: SandboxInvocation[] = [];
const secretCanaries: string[] = [];
const originalSentinels = new Map<string, string | undefined>();
const parentSentinels = freshParentSentinels();

function credential() {
  const value = `E50_SANDBOX_CANARY_${randomBytes(32).toString("hex")}`;
  secretCanaries.push(value);
  return value;
}

function record<T extends SandboxInvocation>(invocation: T) {
  invocations.push(invocation);
  assert.equal(invocation.containerRemoved, true);
  return invocation;
}

describe(
  "Essential 50 Step 2 isolated piece sandbox",
  { skip: runtimeAvailable ? false : `rootless Podman unavailable: ${sandboxRuntimeDescription()}` },
  () => {
    before(() => {
      for (const [name, value] of Object.entries(parentSentinels)) {
        originalSentinels.set(name, process.env[name]);
        process.env[name] = value;
        secretCanaries.push(value);
      }
      ensureSandboxImage();
    });

    after(() => {
      for (const [name, value] of originalSentinels) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      assert.equal(countRunningSandboxContainers(), 0);
    });

    test("rootless image and runtime controls are fixed outside piece code", () => {
      assert.match(sandboxRuntimeDescription(), /rootless=true cgroups=v2 runtime=crun/);
      const image = imageEvidence();
      assert.equal(image.user, "65532:65532");
      assert.doesNotMatch(image.environment, /E50_|SUPABASE|RUNNER|WRAPPING|CREDENTIAL/i);

      const harness = readFileSync(
        "experiments/activepieces-piece-sandbox/harness.ts",
        "utf8",
      );
      for (const required of [
        '"--network=none"',
        '"--read-only"',
        '"--cap-drop=ALL"',
        '"--security-opt=no-new-privileges"',
        '"--pids-limit=16"',
        '"--memory=134217728"',
        '"--memory-swap=134217728"',
        '"--cpus=0.5"',
        '"--log-driver=none"',
      ]) {
        assert.ok(harness.includes(required), `missing runtime control ${required}`);
      }
      assert.doesNotMatch(harness, /--volume|--mount|docker\.sock|--privileged/);
    });

    test("valid one-shot HubSpot invocation is acknowledged through only the mock", () => {
      const invocation = record(invokeSandbox({ credential: credential() }));
      assert.equal(invocation.response.ok, true);
      assert.equal(invocation.response.acknowledged, true);
      assert.equal(invocation.response.output?.credentialReachedProvider, true);
      assert.equal(invocation.response.output?.pieceId, sandboxConstants.pieceId);
      assert.equal(invocation.response.output?.pieceVersion, sandboxConstants.pieceVersion);
      assert.equal(invocation.response.output?.actionId, sandboxConstants.actionId);
      assert.equal(invocation.processStatus, 0);
    });

    test("second invocation uses a fresh container and no prior tmpfs state", () => {
      const first = record(invokeSandbox({ credential: credential(), probeMode: "state" }));
      const second = record(invokeSandbox({ credential: credential(), probeMode: "state" }));
      assert.equal(first.response.output?.previousStateVisible, false);
      assert.equal(second.response.output?.previousStateVisible, false);
      assert.notEqual(
        first.response.meta?.sandboxInstanceId,
        second.response.meta?.sandboxInstanceId,
      );
    });

    test("parent environment and Runner-style sentinels are absent inside the sandbox", () => {
      const invocation = record(
        invokeSandbox({ credential: credential(), probeMode: "environment" }),
      );
      const output = invocation.response.output;
      assert.equal(output?.parentSentinelsVisible, false);
      assert.equal(output?.parentSentinelsVisibleInProc, false);
      assert.equal(output?.runnerSecretsVisible, false);
      assert.equal(output?.uid, 65532);
      assert.equal(output?.effectiveCapabilities, "0000000000000000");
      assert.equal(output?.noNewPrivileges, true);
      assert.equal(output?.seccompMode, 2);
      assert.equal(output?.pidsMax, "16");
      assert.equal(output?.memoryMax, "134217728");
      assert.match(String(output?.cpuMax), /^50000 100000$/);
      assert.deepEqual(output?.externalNetworkInterfaces, []);
    });

    test("host paths and sockets are absent while only bounded tmpfs is writable", () => {
      const invocation = record(
        invokeSandbox({ credential: credential(), probeMode: "filesystem" }),
      );
      assert.deepEqual(invocation.response.output, {
        hostRepoVisible: false,
        hostHomeVisible: false,
        dockerSocketVisible: false,
        rootFilesystemWritable: false,
        tmpfsWritable: true,
      });
    });

    test("network-none blocks external, loopback host, private, metadata, and DNS targets", () => {
      const invocation = record(invokeSandbox({ credential: credential(), probeMode: "network" }));
      assert.deepEqual(invocation.response.output, {
        unapprovedExternalBlocked: true,
        hostLoopbackBlocked: true,
        privateAddressBlocked: true,
        metadataBlocked: true,
        dnsAndPrivateResolutionBlocked: true,
      });
    });

    test("redirect escape leaves the mock and is denied by the container network", () => {
      const invocation = record(invokeSandbox({ credential: credential(), probeMode: "redirect" }));
      assert.equal(invocation.response.ok, false);
      assert.equal(invocation.response.errorCategory, "NETWORK_DENIED");
      assert.equal(invocation.response.retryable, false);
    });

    test("piece, action, and version allowlists fail closed inside the signed boundary", () => {
      const cases = [
        [{ pieceId: "@activepieces/piece-unknown" }, "PIECE_NOT_ALLOWED"],
        [{ actionId: "create-contact" }, "ACTION_NOT_ALLOWED"],
        [{ pieceVersion: "0.8.11" }, "VERSION_NOT_ALLOWED"],
        [{ pieceId: "node:fs", actionId: "readFile" }, "PIECE_NOT_ALLOWED"],
      ] as const;
      for (const [overrides, category] of cases) {
        const invocation = record(
          invokeSandboxWithOverridesForTest({ credential: credential(), overrides }),
        );
        assert.equal(invocation.response.ok, false);
        assert.equal(invocation.response.errorCategory, category);
      }
    });

    test("signed protocol rejects wrong versions and catches response/request mismatches", () => {
      const wrongProtocol = record(
        invokeSandboxWithOverridesForTest({
          credential: credential(),
          overrides: { protocolVersion: "crazyloops.piece-sandbox.v0" },
        }),
      );
      assert.equal(wrongProtocol.response.errorCategory, "UNSUPPORTED_PROTOCOL");

      const mismatch = record(
        invokeSandbox({ credential: credential(), probeMode: "mismatched_request_id" }),
      );
      assert.equal(mismatch.response.errorCategory, "MISMATCHED_REQUEST_ID");
    });

    test("malformed and oversized requests are rejected without execution", () => {
      const malformed = record(invokeRawSandboxForTest("not-json", FALLBACK_REQUEST_ID));
      assert.equal(malformed.response.errorCategory, "MALFORMED_REQUEST");

      const oversized = record(
        invokeRawSandboxForTest(
          "x".repeat(sandboxConstants.maxRequestBytes + 1),
          FALLBACK_REQUEST_ID,
        ),
      );
      assert.equal(oversized.response.errorCategory, "REQUEST_TOO_LARGE");
    });

    test("oversized and malformed sandbox output normalize safely", () => {
      const oversized = record(
        invokeSandbox({ credential: credential(), probeMode: "oversized_output" }),
      );
      assert.equal(oversized.response.errorCategory, "RESPONSE_TOO_LARGE");

      const malformed = record(
        invokeSandbox({ credential: credential(), probeMode: "malformed_output" }),
      );
      assert.equal(malformed.response.errorCategory, "MALFORMED_SANDBOX_RESPONSE");
    });

    test("child processes remain confined and PID and tmpfs resources are bounded", () => {
      const child = record(
        invokeSandbox({ credential: credential(), probeMode: "child_process" }),
      );
      assert.equal(child.response.output?.childExecutedInsideSandbox, true);
      assert.equal(child.response.output?.childConfinedToContainer, true);

      const pids = record(
        invokeSandbox({ credential: credential(), probeMode: "pid_exhaustion" }),
      );
      assert.equal(pids.response.output?.spawnRejected, true);
      assert.ok(Number(pids.response.output?.started) < 64);

      const temp = record(
        invokeSandbox({ credential: credential(), probeMode: "temp_storage" }),
      );
      assert.equal(temp.response.output?.temporaryStorageBounded, true);
    });

    test("memory and CPU abuse are terminated and normalized by the parent", () => {
      const memory = record(
        invokeSandbox({
          credential: credential(),
          probeMode: "memory_exhaustion",
          timeoutMs: 20_000,
        }),
      );
      assert.equal(memory.response.errorCategory, "SANDBOX_RESOURCE_LIMIT");
      assert.equal(existsSync("oom"), false);

      const cpu = record(
        invokeSandbox({ credential: credential(), probeMode: "cpu_loop", timeoutMs: 10_000 }),
      );
      assert.equal(cpu.response.errorCategory, "SANDBOX_TIMEOUT");
      assert.equal(countRunningSandboxContainers(), 0);
    });

    test("provider failures use bounded categories and never expose raw bodies", () => {
      const cases = [
        ["auth_401", "PROVIDER_AUTHENTICATION_FAILED", false],
        ["rate_429", "PROVIDER_RATE_LIMITED", true],
        ["provider_400", "PROVIDER_REJECTED", false],
        ["provider_500", "PROVIDER_UNAVAILABLE", true],
        ["malformed_provider", "MALFORMED_PROVIDER_RESPONSE", false],
      ] as const;
      for (const [probeMode, category, retryable] of cases) {
        const invocation = record(invokeSandbox({ credential: credential(), probeMode }));
        assert.equal(invocation.response.errorCategory, category);
        assert.equal(invocation.response.retryable, retryable);
        assert.doesNotMatch(invocation.stdout, /sensitive provider body|sensitive validation body|sensitive outage body/);
      }
    });

    test("five fresh successful invocations provide one-shot performance evidence", () => {
      const samples = Array.from({ length: 5 }, () =>
        record(invokeSandbox({ credential: credential() })),
      );
      assert.equal(samples.every((sample) => sample.response.ok), true);
      assert.equal(new Set(samples.map((sample) => sample.response.meta?.sandboxInstanceId)).size, 5);
      assert.equal(samples.every((sample) => sample.containerRemoved), true);
    });

    test("credential and parent canaries persist on zero inspected surfaces", () => {
      assert.equal(canaryPersistenceOccurrences(secretCanaries, invocations), 0);
      assert.equal(countRunningSandboxContainers(), 0);
    });
  },
);
