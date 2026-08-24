import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";

import {
  cleanupExperiment,
  egressConstants,
  experimentArtifactCounts,
  freshParentSentinels,
  gatewayCanaryOccurrences,
  invokeAllowed,
  invokeNetworkProbe,
  runtimeAvailable,
  runtimeDirectoryEntries,
  type EgressInvocation,
} from "../experiments/activepieces-piece-egress/harness";
import { isSafePublicAddress } from "../experiments/activepieces-piece-egress/ip-policy.mjs";
import { EGRESS_LIMITS, EGRESS_OUTCOMES, PROVIDER_MANIFEST } from "../experiments/activepieces-piece-egress/provider-manifest.mjs";

const available = runtimeAvailable();
const invocations: EgressInvocation[] = [];
const canaries: string[] = [];
const sentinels = freshParentSentinels();
const previous = new Map<string, string | undefined>();

function credential() {
  const value = `E50_EGRESS_FAKE_${randomBytes(32).toString("hex")}`;
  canaries.push(value);
  return value;
}

function record(invocation: EgressInvocation) {
  invocations.push(invocation);
  assert.equal(invocation.containersRemoved, true);
  assert.equal(invocation.networksRemoved, true);
  return invocation;
}

function outcomes(invocation: EgressInvocation) {
  return invocation.gatewayEvents.map((event) => event.outcome).filter(Boolean);
}

describe("Essential 50 Step 3 controlled provider egress", { skip: available ? false : "rootless Podman unavailable" }, () => {
  before(() => {
    for (const [name, value] of Object.entries(sentinels)) {
      previous.set(name, process.env[name]);
      process.env[name] = value;
      canaries.push(value);
    }
  });

  after(() => {
    assert.equal(gatewayCanaryOccurrences(canaries, invocations), 0);
    assert.deepEqual(experimentArtifactCounts(), { containers: 0, networks: 0 });
    assert.equal(runtimeDirectoryEntries().some((entry) => /\.key$|\.crt$|\.csr$|\.srl$/i.test(entry)), false);
    cleanupExperiment();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("trusted manifest has one exact TLS destination and bounded outcomes", () => {
    assert.deepEqual(PROVIDER_MANIFEST, {
      capability: "hubspot.get_contact",
      piece: "@activepieces/piece-hubspot",
      pieceVersion: "0.8.10",
      action: "get-contact",
      destinations: [{ hostname: "api.hubapi.com", port: 443, protocol: "tls" }],
    });
    assert.equal(JSON.stringify(PROVIDER_MANIFEST).includes("*"), false);
    assert.deepEqual(EGRESS_LIMITS, {
      clientHelloBytes: 16 * 1024,
      upstreamBytes: 128 * 1024,
      downstreamBytes: 128 * 1024,
      handshakeMs: 1_500,
      connectMs: 1_500,
      idleMs: 2_000,
      lifetimeMs: 5_000,
      simultaneousConnections: 2,
    });
    assert.equal(EGRESS_OUTCOMES.length, 9);
  });

  test("parsed IP policy rejects private, local, metadata, reserved, and unsafe IPv6", () => {
    for (const address of [
      "127.0.0.1", "10.1.2.3", "172.16.1.2", "172.31.255.254", "192.168.1.2",
      "169.254.169.254", "100.64.1.2", "0.0.0.0", "224.0.0.1", "240.0.0.1",
      "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1",
    ]) assert.equal(isSafePublicAddress(address), false, address);
    assert.equal(isSafePublicAddress("8.8.8.8"), true);
    assert.equal(isSafePublicAddress("2606:4700:4700::1111"), true);
  });

  test("normal pinned HubSpot SDK flow reaches only the TLS mock", () => {
    const result = record(invokeAllowed({ credential: credential(), contactId: "allowed" }));
    assert.equal(result.response.ok, true);
    assert.equal(result.response.acknowledged, true);
    const output = result.response.output as Record<string, unknown>;
    const properties = output.properties as Record<string, unknown>;
    assert.equal(output.pieceId, "@activepieces/piece-hubspot");
    assert.equal(output.pieceVersion, "0.8.10");
    assert.equal(output.actionId, "get-contact");
    assert.equal(properties.credentialAccepted, "true");
    assert.deepEqual(outcomes(result), ["EGRESS_SUCCEEDED"]);
    assert.doesNotMatch(result.gatewayLogs, /authorization|bearer|reader@example/i);
  });

  test("internal-only sandbox blocks the complete direct-bypass matrix", () => {
    const result = record(invokeNetworkProbe("matrix"));
    const response = result.response as Record<string, { blocked?: boolean; connected?: number }>;
    for (const [name, evidence] of Object.entries(response)) assert.equal(evidence.blocked, true, name);
    assert.ok((response.connectionLimit.connected ?? 99) <= EGRESS_LIMITS.simultaneousConnections);
    assert.ok(outcomes(result).includes("EGRESS_TLS_POLICY_DENIED"));
    assert.ok(outcomes(result).includes("EGRESS_PROTOCOL_INVALID"));
    assert.ok(outcomes(result).includes("EGRESS_CONNECTION_FAILED"));
  });

  test("gateway resolution fails closed and rejects private/metadata/IPv6-local answers", () => {
    const cases = [
      ["private", "EGRESS_DNS_DENIED"],
      ["metadata", "EGRESS_DNS_DENIED"],
      ["ipv6_private", "EGRESS_DNS_DENIED"],
      ["dns_failure", "EGRESS_DNS_FAILED"],
    ] as const;
    for (const [scenario, category] of cases) {
      const result = record(invokeAllowed({ credential: credential(), scenario }));
      assert.equal(result.response.ok, false);
      assert.equal(result.response.errorCategory, category);
      assert.ok(outcomes(result).includes(category));
    }
  });

  test("DNS rebind pins the first connection and rejects a private answer on the next", () => {
    const result = record(invokeAllowed({ credential: credential(), contactId: "rebind", scenario: "rebind" }));
    assert.equal(result.response.ok, true);
    const properties = (result.response.output as { properties: Record<string, unknown> }).properties;
    assert.equal(properties.rebindSecondDenied, "true");
    assert.deepEqual(outcomes(result), ["EGRESS_SUCCEEDED", "EGRESS_DNS_DENIED"]);
  });

  test("redirect escape cannot leave the approved hostname/network", () => {
    const result = record(invokeAllowed({ credential: credential(), contactId: "redirect" }));
    assert.equal(result.response.ok, false);
    assert.equal(result.response.errorCategory, "EGRESS_DESTINATION_DENIED");
    assert.deepEqual(outcomes(result), ["EGRESS_SUCCEEDED"]);
  });

  test("gateway independently enforces transfer and connection lifetime limits", () => {
    const oversized = record(invokeAllowed({ credential: credential(), contactId: "oversized" }));
    assert.equal(oversized.response.ok, false);
    assert.equal(oversized.response.errorCategory, "EGRESS_TRANSFER_LIMIT");
    assert.ok(outcomes(oversized).includes("EGRESS_TRANSFER_LIMIT"));

    const timeout = record(invokeAllowed({ credential: credential(), contactId: "timeout" }));
    assert.equal(timeout.response.ok, false);
    assert.equal(timeout.response.errorCategory, "EGRESS_TIMEOUT");
    assert.ok(outcomes(timeout).includes("EGRESS_TIMEOUT"));
  });

  test("piece and gateway run non-root with enforced seccomp and no ambient privilege", () => {
    const allowed = invocations.find((item) => item.response.ok === true && outcomes(item).includes("EGRESS_SUCCEEDED"));
    assert.ok(allowed);
    const runtime = allowed.gatewayEvents.find((event) => event.event === "gateway_runtime");
    assert.deepEqual({ uid: runtime?.uid, seccomp: runtime?.seccomp, capabilities: runtime?.capabilities, noNewPrivileges: runtime?.noNewPrivileges }, {
      uid: 65532, seccomp: "2", capabilities: "0000000000000000", noNewPrivileges: "1",
    });
    const meta = allowed.response.meta as { security: Record<string, unknown> };
    assert.equal(meta.security.uid, 65532);
    assert.equal(meta.security.seccomp, "2");
    assert.equal(meta.security.capabilities, "0000000000000000");
    assert.equal(meta.security.noNewPrivileges, "1");
    const diff = allowed.gatewayDiff.trim();
    assert.ok(diff === "" || diff.split(/\r?\n/).every((line) => line === "C /etc"));
    const inspect = allowed.gatewayInspect.toLowerCase();
    const parsedInspect = JSON.parse(allowed.gatewayInspect) as Array<{ Mounts?: unknown[] }>;
    assert.deepEqual(parsedInspect[0]?.Mounts ?? [], []);
    assert.doesNotMatch(inspect, /docker\.sock|podman\.sock|"privileged":\s*true/);
    assert.match(inspect, /no-new-privileges/);
  });

  test("source boundary has no arbitrary proxy API, credential plumbing, or production import", () => {
    const gateway = readFileSync("experiments/activepieces-piece-egress/gateway.mjs", "utf8");
    const harness = readFileSync("experiments/activepieces-piece-egress/harness.ts", "utf8");
    assert.doesNotMatch(gateway, /authorization|bearer|credential|connect\s*\(\s*host\s*,\s*port/i);
    assert.doesNotMatch(harness, /--privileged|--security-opt["',\s=]+seccomp=unconfined|--volume|--mount|docker\.sock|podman\.sock/);
    assert.match(harness, /"--cap-drop=ALL"/);
    assert.match(harness, /"--security-opt=no-new-privileges"/);
    assert.match(harness, /"--read-only"/);
    assert.match(harness, /"--internal"/);
    assert.equal(egressConstants.label, "crazyloops.experiment=e50-piece-egress");
  });
});
