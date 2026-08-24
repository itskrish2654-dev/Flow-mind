import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { runtimeCommand } from "../experiments/activepieces-piece-realhost/container-runtime";
import { isSafePublicAddress } from "../experiments/activepieces-piece-realhost/ip-policy.mjs";
import { PROVIDER_MANIFEST } from "../experiments/activepieces-piece-realhost/provider-manifest.mjs";
import { resolveApprovedHostname } from "../experiments/activepieces-piece-realhost/real-dns.mjs";

function dnsError(code: string) {
  return Object.assign(new Error(code), { code });
}

describe("Essential 50 Step 4A.2 Docker real-host preparation", () => {
  test("Docker and accepted Podman command paths stay explicit", () => {
    assert.deepEqual(runtimeCommand("docker", ["info"], "linux"), { executable: "docker", args: ["info"] });
    assert.deepEqual(runtimeCommand("podman", ["info"], "linux"), { executable: "podman", args: ["info"] });
    assert.deepEqual(runtimeCommand("podman", ["info"], "win32"), { executable: "wsl.exe", args: ["-d", "Ubuntu", "--", "podman", "info"] });
  });

  test("real DNS accepts all-safe A/AAAA answers and pins the first numeric address", async () => {
    const result = await resolveApprovedHostname({
      resolve4: async () => [{ address: "8.8.8.8", ttl: 120 }],
      resolve6: async () => [{ address: "2606:4700:4700::1111", ttl: 60 }],
    });
    assert.equal(result.hostname, "api.hubapi.com");
    assert.equal(result.pinnedAddress, "8.8.8.8");
    assert.equal(result.family, 4);
    assert.deepEqual(result.evidence, [
      { family: 4, ttl: 120, classification: "SAFE" },
      { family: 6, ttl: 60, classification: "SAFE" },
    ]);
  });

  test("all-unsafe and mixed DNS answers fail closed", async () => {
    await assert.rejects(
      resolveApprovedHostname({ resolve4: async () => [{ address: "10.0.0.1", ttl: 30 }], resolve6: async () => [] }),
      (error: { category?: string }) => error.category === "EGRESS_DNS_DENIED",
    );
    await assert.rejects(
      resolveApprovedHostname({ resolve4: async () => [{ address: "8.8.8.8", ttl: 30 }, { address: "169.254.169.254", ttl: 30 }], resolve6: async () => [] }),
      (error: { category?: string }) => error.category === "EGRESS_DNS_DENIED",
    );
  });

  test("private/local IPv4, IPv6, and mapped IPv6 cannot bypass classification", () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      assert.equal(isSafePublicAddress(address), false, address);
    }
  });

  test("empty, NXDOMAIN, resolver failure, malformed records, and timeout fail closed", async () => {
    const noData = async () => { throw dnsError("ENODATA"); };
    const nxdomain = async () => { throw dnsError("ENOTFOUND"); };
    for (const operation of [
      resolveApprovedHostname({ resolve4: async () => [], resolve6: async () => [] }),
      resolveApprovedHostname({ resolve4: nxdomain, resolve6: nxdomain }),
      resolveApprovedHostname({ resolve4: async () => { throw dnsError("ESERVFAIL"); }, resolve6: noData }),
      resolveApprovedHostname({ resolve4: async () => [{ address: "not-an-ip", ttl: 30 }], resolve6: async () => [] }),
    ]) await assert.rejects(operation, (error: { category?: string }) => error.category === "EGRESS_DNS_FAILED");
    await assert.rejects(
      resolveApprovedHostname({ resolve4: async () => new Promise(() => {}), resolve6: async () => new Promise(() => {}), timeoutMs: 10 }),
      (error: { category?: string }) => error.category === "EGRESS_TIMEOUT",
    );
  });

  test("destination authority remains exact and cannot be caller-selected", async () => {
    assert.deepEqual(PROVIDER_MANIFEST, {
      capability: "hubspot.get_contact",
      piece: "@activepieces/piece-hubspot",
      pieceVersion: "0.8.10",
      action: "get-contact",
      destinations: [{ hostname: "api.hubapi.com", port: 443, protocol: "tls" }],
    });
    await assert.rejects(
      resolveApprovedHostname({ hostname: "example.com", resolve4: async () => [{ address: "8.8.8.8", ttl: 30 }], resolve6: async () => [] }),
      (error: { category?: string }) => error.category === "EGRESS_DESTINATION_DENIED",
    );
  });

  test("gateway preserves raw TLS and connects to the resolver-pinned numeric address", () => {
    const source = readFileSync("experiments/activepieces-piece-realhost/gateway.mjs", "utf8");
    assert.match(source, /resolveApprovedHostname/);
    assert.match(source, /connectTcp\(\{ host: resolved\.pinnedAddress/);
    assert.match(source, /parsed\.hostname !== destination\.hostname/);
    assert.doesNotMatch(source, /createSecureContext|createServer\s*\(\s*\{\s*key|authorization|bearer/i);
    assert.doesNotMatch(source, /connect\s*\(\s*host\s*,\s*port/i);
  });

  test("real TLS probe sends no application data or authentication", () => {
    const source = readFileSync("experiments/activepieces-piece-realhost/tls-probe.mjs", "utf8");
    assert.match(source, /E50_TLS_CONNECT_HOST/);
    assert.match(source, /host: connectHost/);
    assert.match(source, /servername: hostname/);
    assert.match(source, /rejectUnauthorized: true/);
    assert.match(source, /applicationDataSent: false/);
    assert.doesNotMatch(source, /socket\.write\(|authorization|bearer|token/i);
  });

  test("real provider DNS is separate from the sandbox gateway alias", () => {
    const source = readFileSync("experiments/activepieces-piece-realhost/host-acceptance.ts", "utf8");
    assert.match(
      source,
      /"--alias", "e50-hubspot-gateway", internal, gateway\], "connect real gateway internal"/,
    );
    assert.doesNotMatch(
      source,
      /"--alias", "api\.hubapi\.com", internal, gateway\], "connect real gateway internal"/,
    );
    assert.match(source, /E50_TLS_CONNECT_HOST=e50-hubspot-gateway/);
  });

  test("Docker controls are fixed outside piece code and expose no host mounts/socket", () => {
    const source = readFileSync("experiments/activepieces-piece-realhost/host-acceptance.ts", "utf8");
    for (const control of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=16", "--memory", "--memory-swap", "--cpus", "nofile=64:64", "--user", "65532:65532", "--tmpfs"]) assert.ok(source.includes(control), control);
    assert.doesNotMatch(source, /--privileged|--volume|--mount|docker\.sock|podman\.sock|seccomp=unconfined/);
    assert.match(source, /AppArmorProfile/);
    assert.match(source, /seccomp/);
  });

  test("operator script is explicit, label-scoped, offline at runtime, and production-safe", () => {
    const script = readFileSync("scripts/e50-step4a-host-acceptance.sh", "utf8");
    const harness = readFileSync("experiments/activepieces-piece-realhost/host-acceptance.ts", "utf8");
    assert.match(script, /E50_ACCEPT_STEP4A/);
    assert.match(script, /E50_EXPECTED_COMMIT/);
    assert.match(script, /crazyloops\.experiment=e50-step4a/);
    assert.match(script, /npx --no-install tsx/);
    assert.match(script, /trap cleanup EXIT INT TERM/);
    assert.doesNotMatch(script, /docker\s+(restart|stop)|systemctl\s+(restart|stop)|ufw\s+|iptables\s+-|nft\s+(add|delete|flush)|redis-cli\s+(SET|DEL|FLUSH)|\.env/);
    assert.doesNotMatch(script, /crazyloops-private.*network connect|activepieces_activepieces.*network connect/);
    assert.match(harness, /const PREFIX = "cl-e50-canary-"/);
    assert.match(harness, /sandbox: `\$\{PREFIX\}sandbox:/);
    assert.match(harness, /gateway: `\$\{PREFIX\}gateway:/);
    assert.match(harness, /mock: `\$\{PREFIX\}mock:/);
    assert.doesNotMatch(harness, /crazyloops\/e50-step4a-(sandbox|gateway|mock)/);
  });

  test("harness snapshots protected services without inspecting their environment", () => {
    const source = readFileSync("experiments/activepieces-piece-realhost/host-acceptance.ts", "utf8");
    for (const name of ["crazyloops-connector-runner", "activepieces-app", "activepieces-worker-1", "redis"]) assert.ok(source.includes(name));
    assert.match(source, /127\.0\.0\.1:8788/);
    assert.match(source, /127\.0\.0\.1:8080/);
    assert.match(source, /compareInfrastructure/);
    assert.doesNotMatch(source, /Config\.Env|\.env\.local|process\.env\[["']SUPABASE|ACTIVEPIECES_BRIDGE_SECRET/);
  });

  test("Runner precheck sends valid unsigned JSON and requires authentication rejection", () => {
    const source = readFileSync("experiments/activepieces-piece-realhost/host-acceptance.ts", "utf8");
    const probe = source.match(/const runnerStatus = command\("curl", \[[\s\S]*?\]\);/)?.[0] ?? "";
    assert.match(probe, /"-X", "POST"/);
    assert.match(probe, /"-H", "Content-Type: application\/json"/);
    assert.match(probe, /"--data", "\{\}"/);
    assert.match(probe, /http:\/\/127\.0\.0\.1:8788\/v1\/execute/);
    assert.doesNotMatch(probe, /authorization|x-crazyloops|signature|secret/i);
    assert.match(source, /runnerStatus\.stdout\.trim\(\) !== "401"/);
  });

  test("fake canaries, two-way concurrency, failures, performance, and sanitized report are mandatory", () => {
    const source = readFileSync("experiments/activepieces-piece-realhost/host-acceptance.ts", "utf8");
    assert.match(source, /E50_HUBSPOT_FAKE_/);
    assert.match(source, /runConcurrent/);
    assert.match(source, /Array\.from\(\{ length: 10 \}/);
    assert.match(source, /runResourceFailure\("crash"\)/);
    assert.match(source, /runResourceFailure\("oom"\)/);
    assert.match(source, /runGatewayFailure/);
    assert.match(source, /plaintextOccurrences !== 0/);
    assert.match(source, /safeToShare: true/);
    assert.match(source, /SAFE TO SHARE WITH SOL: YES/);
  });

  test("no customer-facing production registry or application module imports the experiment", () => {
    const files = ["lib/capability-registry.ts", "lib/connectors/registry.ts", "lib/workflow-planner.ts", "lib/workflow-compiler.ts"];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /activepieces-piece-realhost|e50-step4a|hubspot\.get_contact/);
    }
  });
});
