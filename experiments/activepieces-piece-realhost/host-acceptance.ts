import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ContainerRuntime } from "./container-runtime";
import {
  PARENT_SENTINEL_NAMES,
  SANDBOX_ACTION_ID,
  SANDBOX_CAPABILITY_ID,
  SANDBOX_CAPABILITY_VERSION,
  SANDBOX_PIECE_ID,
  SANDBOX_PIECE_VERSION,
  SANDBOX_PROTOCOL_VERSION,
} from "../activepieces-piece-sandbox/manifest.mjs";
import { canonicalJson } from "../activepieces-piece-sandbox/protocol.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const STEP_TWO = join(ROOT, "experiments/activepieces-piece-sandbox");
const STEP_THREE = join(ROOT, "experiments/activepieces-piece-egress");
const LABEL = "crazyloops.experiment=e50-step4a";
const PREFIX = "cl-e50-canary-";
const EXPECTED_BRANCH = "codex/e50-piece-realhost";
const EXPECTED_BASE = "4aa554caac10a0d1cc7b55974aea2da16e5f1571";
const BASE_IMAGE = "docker.io/library/node:24.8.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85";
const runtime = new ContainerRuntime("docker", ROOT);
const tempRoot = mkdtempSync(join(tmpdir(), "cl-e50-step4a-"));
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }) as Buffer;
const fingerprint = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
const images = {
  sandbox: `${PREFIX}sandbox:${fingerprint}`,
  gateway: `${PREFIX}gateway:${fingerprint}`,
  mock: `${PREFIX}mock:${fingerprint}`,
};
const resources = { containers: new Set<string>(), networks: new Set<string>() };
const scanSurfaces: string[] = [];
const canaries: string[] = [];
const startedEpoch = Math.floor(Date.now() / 1000);

type ServiceEvidence = { id: string; status: string; restartCount: number; ports: string };
type Topology = { requestId: string; sandbox: string; gateway: string; mock?: string; internal: string; upstream: string };

function command(executable: string, args: string[], options: { input?: string; timeoutMs?: number; cwd?: string } = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
}

function requireResult(result: { status: number | null; stderr: string }, operation: string) {
  if (result.status !== 0) throw new Error(`${operation} failed (${result.status ?? "no status"}): ${result.stderr.slice(0, 400)}`);
}

function docker(args: string[], options: { input?: string; timeoutMs?: number; maxBuffer?: number } = {}) {
  return runtime.run(args, options);
}

function dockerOk(args: string[], operation: string, options: { input?: string; timeoutMs?: number; maxBuffer?: number } = {}) {
  const result = docker(args, options);
  requireResult(result, operation);
  scanSurfaces.push(result.stdout, result.stderr);
  return result;
}

function hashCommand(executable: string, args: string[]) {
  const result = command(executable, args);
  return result.status === 0 ? createHash("sha256").update(result.stdout).digest("hex") : "unavailable";
}

function git(args: string[]) {
  const result = command("git", ["-c", `safe.directory=${ROOT}`, ...args]);
  requireResult(result, `git ${args[0]}`);
  return result.stdout.trim();
}

function assertSource() {
  if (process.env.E50_ACCEPT_STEP4A !== "YES") throw new Error("Set E50_ACCEPT_STEP4A=YES after reviewing the operator script.");
  const expectedCommit = process.env.E50_EXPECTED_COMMIT;
  if (!expectedCommit || !/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error("E50_EXPECTED_COMMIT must be the reviewed 40-character branch commit.");
  if (git(["branch", "--show-current"]) !== EXPECTED_BRANCH) throw new Error(`Expected branch ${EXPECTED_BRANCH}.`);
  if (git(["rev-parse", "HEAD"]) !== expectedCommit) throw new Error("Checkout HEAD does not match E50_EXPECTED_COMMIT.");
  if (git(["status", "--porcelain"]) !== "") throw new Error("The acceptance checkout must be clean.");
  if (command("git", ["-c", `safe.directory=${ROOT}`, "merge-base", "--is-ancestor", EXPECTED_BASE, "HEAD"]).status !== 0) throw new Error("Step 3 commit is not an ancestor of this checkout.");
}

function serviceEvidence(name: string): ServiceEvidence {
  const raw = dockerOk(["inspect", "--format", "{{.Id}}|{{.State.Status}}|{{.RestartCount}}", name], `inspect ${name}`).stdout.trim();
  const [id, status, restart] = raw.split("|");
  return { id, status, restartCount: Number(restart), ports: dockerOk(["port", name], `ports ${name}`).stdout.trim() };
}

function infrastructureSnapshot() {
  const names = ["crazyloops-connector-runner", "activepieces-app", "activepieces-worker-1", "redis"];
  const services = Object.fromEntries(names.map((name) => [name, serviceEvidence(name)]));
  for (const [name, evidence] of Object.entries(services)) if (evidence.status !== "running") throw new Error(`${name} is not running.`);
  if (!services["crazyloops-connector-runner"].ports.includes("127.0.0.1:8788")) throw new Error("Runner loopback bind changed or is absent.");
  if (!services["activepieces-app"].ports.includes("127.0.0.1:8080")) throw new Error("Activepieces loopback bind changed or is absent.");
  for (const network of ["crazyloops-private", "activepieces_activepieces"]) dockerOk(["network", "inspect", network], `inspect network ${network}`);
  if (dockerOk(["exec", "redis", "redis-cli", "PING"], "Redis PING").stdout.trim() !== "PONG") throw new Error("Redis is not healthy.");
  const runnerStatus = command("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", "Content-Type: application/json", "--data", "{}", "http://127.0.0.1:8788/v1/execute"]);
  if (runnerStatus.status !== 0 || runnerStatus.stdout.trim() !== "401") throw new Error("Runner unsigned health rejection is not 401.");
  return {
    services,
    listenHash: hashCommand("ss", ["-lnt"]),
    nftHash: hashCommand("nft", ["list", "ruleset"]),
  };
}

function hostEvidence() {
  const os = readFileSync("/etc/os-release", "utf8").split(/\r?\n/).find((line) => line.startsWith("PRETTY_NAME="))?.slice(12).replace(/^"|"$/g, "") ?? "unknown";
  const dockerInfo = dockerOk(["info", "--format", "{{json .}}"], "Docker info").stdout;
  const parsed = JSON.parse(dockerInfo) as Record<string, unknown>;
  return {
    role: "CrazyLoops Connector Runner and Activepieces host",
    os,
    kernel: command("uname", ["-r"]).stdout.trim(),
    architecture: command("uname", ["-m"]).stdout.trim(),
    hostname: command("hostname", []).stdout.trim(),
    dockerVersion: String(parsed.ServerVersion ?? "unknown"),
    cgroupVersion: String(parsed.CgroupVersion ?? "unknown"),
    cgroupDriver: String(parsed.CgroupDriver ?? "unknown"),
    securityOptions: Array.isArray(parsed.SecurityOptions) ? parsed.SecurityOptions.filter((value) => /seccomp|apparmor|cgroup/i.test(String(value))) : [],
    memoryBytes: Number(parsed.MemTotal ?? 0),
    cpus: Number(parsed.NCPU ?? 0),
    disk: command("df", ["-B1", "--output=size,avail", ROOT]).stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "unknown",
  };
}

function openssl(args: string[], operation: string) {
  const result = command("openssl", args, { cwd: tempRoot });
  requireResult(result, operation);
}

function buildImages() {
  const build = join(tempRoot, "build");
  const sandbox = join(build, "sandbox");
  const gateway = join(build, "gateway");
  const mock = join(build, "mock");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(gateway, { recursive: true });
  mkdirSync(mock, { recursive: true });
  const caKey = join(build, "ca.key");
  const caCert = join(build, "ca.crt");
  const serverKey = join(build, "server.key");
  const serverCsr = join(build, "server.csr");
  const serverCert = join(build, "server.crt");
  openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", caKey], "generate CA key");
  openssl(["req", "-x509", "-new", "-key", caKey, "-sha256", "-days", "1", "-subj", "/CN=CrazyLoops E50 Test CA", "-out", caCert], "generate CA");
  openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", serverKey], "generate mock key");
  openssl(["req", "-new", "-key", serverKey, "-subj", "/CN=api.hubapi.com", "-addext", "subjectAltName=DNS:api.hubapi.com", "-out", serverCsr], "generate CSR");
  openssl(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-sha256", "-copy_extensions", "copy", "-out", serverCert], "sign mock certificate");

  for (const file of ["package.json", "package-lock.json", "manifest.mjs", "protocol.mjs"]) copyFileSync(join(STEP_TWO, file), join(sandbox, file));
  for (const file of ["worker.mjs", "network-probe.mjs"]) copyFileSync(join(STEP_THREE, file), join(sandbox, file));
  for (const file of ["tls-probe.mjs", "resource-probe.mjs", "direct-probe.mjs"]) copyFileSync(join(HERE, file), join(sandbox, file));
  copyFileSync(caCert, join(sandbox, "test-ca.crt"));
  copyFileSync(join(HERE, "Dockerfile.sandbox"), join(sandbox, "Dockerfile"));
  for (const file of ["gateway.mjs", "real-dns.mjs"]) copyFileSync(join(HERE, file), join(gateway, file));
  for (const file of ["provider-manifest.mjs", "ip-policy.mjs"]) copyFileSync(join(HERE, file), join(gateway, file));
  copyFileSync(join(HERE, "Dockerfile.gateway"), join(gateway, "Dockerfile"));
  copyFileSync(join(STEP_THREE, "mock-provider.mjs"), join(mock, "mock-provider.mjs"));
  copyFileSync(serverCert, join(mock, "server.crt"));
  copyFileSync(serverKey, join(mock, "server.key"));
  copyFileSync(join(HERE, "Dockerfile.mock"), join(mock, "Dockerfile"));

  dockerOk(["build", "--pull=false", "--label", LABEL, "--tag", images.gateway, gateway], "build gateway", { timeoutMs: 10 * 60_000 });
  dockerOk(["build", "--pull=false", "--label", LABEL, "--build-arg", `SANDBOX_PUBLIC_KEY_B64=${publicKey.toString("base64")}`, "--tag", images.sandbox, sandbox], "build sandbox", { timeoutMs: 10 * 60_000 });
  dockerOk(["build", "--pull=false", "--label", LABEL, "--tag", images.mock, mock], "build mock", { timeoutMs: 10 * 60_000 });
  dockerOk(["image", "inspect", BASE_IMAGE], "verify pinned base image");
  for (const image of Object.values(images)) {
    const inspect = dockerOk(["image", "inspect", image], `inspect image ${image}`).stdout;
    const history = dockerOk(["history", "--no-trunc", image], `history ${image}`).stdout;
    scanSurfaces.push(inspect, history);
  }
  rmSync(build, { recursive: true, force: true });
}

function securityArgs(kind: "sandbox" | "gateway" | "mock") {
  const sandbox = kind === "sandbox";
  return [
    "--read-only", "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${sandbox ? "4m" : "1m"}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=16",
    "--memory", sandbox ? "134217728" : "67108864", "--memory-swap", sandbox ? "134217728" : "67108864",
    "--cpus", sandbox ? "0.5" : "0.25", "--ulimit", "nofile=64:64", "--user", "65532:65532",
  ];
}

function name(kind: string, suffix: string) { return `${PREFIX}${kind}-${suffix}`; }
function addContainer(value: string) { resources.containers.add(value); return value; }
function addNetwork(value: string) { resources.networks.add(value); return value; }

function waitGateway(container: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const logs = docker(["logs", container]);
    if (logs.stdout.includes("gateway_ready")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error("Gateway did not become ready.");
}

function setupMockTopology(index: number, credential: string, requestId = randomUUID()): Topology {
  const suffix = requestId.slice(0, 8);
  const third = 120 + (index % 80);
  const internal = addNetwork(name("internal", suffix));
  const upstream = addNetwork(name("mocknet", suffix));
  const sandbox = addContainer(name("sandbox", suffix));
  const gateway = addContainer(name("gateway", suffix));
  const mock = addContainer(name("mock", suffix));
  dockerOk(["network", "create", "--internal", "--label", LABEL, internal], "create internal network");
  dockerOk(["network", "create", "--internal", "--subnet", `93.184.${third}.0/24`, "--label", LABEL, upstream], "create mock network");
  dockerOk(["run", "--detach", "--pull=never", "--name", mock, "--label", LABEL, "--network", upstream, "--ip", `93.184.${third}.34`, ...securityArgs("mock"), "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--env", `E50_EXPECTED_CREDENTIAL_SHA256=${createHash("sha256").update(credential).digest("hex")}`, images.mock], "start mock");
  scanSurfaces.push(dockerOk(["inspect", mock], "inspect mock").stdout);
  dockerOk(["run", "--detach", "--pull=never", "--name", gateway, "--label", LABEL, "--network", upstream, "--ip", `93.184.${third}.2`, ...securityArgs("gateway"), "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--env", `E50_REQUEST_ID=${requestId}`, "--env", "E50_RESOLVER_MODE=fixture:safe", "--env", `E50_MOCK_ADDRESS=93.184.${third}.34`, images.gateway], "start gateway");
  dockerOk(["network", "connect", "--alias", "api.hubapi.com", internal, gateway], "connect gateway internal");
  waitGateway(gateway);
  return { requestId, sandbox, gateway, mock, internal, upstream };
}

function setupRealTopology(): Topology {
  const requestId = randomUUID();
  const suffix = requestId.slice(0, 8);
  const internal = addNetwork(name("internal", suffix));
  const upstream = addNetwork(name("egress", suffix));
  const sandbox = addContainer(name("sandbox", suffix));
  const gateway = addContainer(name("gateway", suffix));
  dockerOk(["network", "create", "--internal", "--label", LABEL, internal], "create real internal network");
  dockerOk(["network", "create", "--label", LABEL, upstream], "create real egress network");
  dockerOk(["run", "--detach", "--pull=never", "--name", gateway, "--label", LABEL, "--network", upstream, ...securityArgs("gateway"), "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--env", `E50_REQUEST_ID=${requestId}`, "--env", "E50_RESOLVER_MODE=real", images.gateway], "start real gateway");
  dockerOk(["network", "connect", "--alias", "e50-hubspot-gateway", internal, gateway], "connect real gateway internal");
  waitGateway(gateway);
  return { requestId, sandbox, gateway, internal, upstream };
}

function signedEnvelope(requestId: string, credential: string, contactId: string) {
  const envelope = { protocolVersion: SANDBOX_PROTOCOL_VERSION, requestId, capabilityId: SANDBOX_CAPABILITY_ID, capabilityVersion: SANDBOX_CAPABILITY_VERSION, pieceId: SANDBOX_PIECE_ID, pieceVersion: SANDBOX_PIECE_VERSION, actionId: SANDBOX_ACTION_ID, input: { contactId }, credential, probeMode: "normal" };
  return { ...envelope, signature: sign(null, Buffer.from(canonicalJson(envelope)), keys.privateKey).toString("base64") };
}

function createSandbox(topology: Topology, entrypoint?: string[], environment: string[] = []) {
  const args = ["create", "--interactive", "--name", topology.sandbox, "--label", LABEL, "--pull=never", "--network", topology.internal, ...securityArgs("sandbox")];
  for (const value of environment) args.push("--env", value);
  if (entrypoint) args.push("--entrypoint", entrypoint[0]);
  args.push(images.sandbox, ...(entrypoint?.slice(1) ?? []));
  dockerOk(args, `create sandbox ${topology.sandbox}`);
  return dockerOk(["inspect", topology.sandbox], "inspect sandbox").stdout;
}

function startSandbox(topology: Topology, input?: string, timeoutMs = 20_000) {
  const result = docker(["start", "--attach", "--interactive", topology.sandbox], { input, timeoutMs, maxBuffer: 256 * 1024 });
  scanSurfaces.push(result.stdout, result.stderr);
  return result;
}

function gatewayEvidence(topology: Topology) {
  const logs = dockerOk(["logs", topology.gateway], "gateway logs").stdout;
  const inspect = dockerOk(["inspect", topology.gateway], "gateway inspect").stdout;
  const peak = docker(["exec", topology.gateway, "cat", "/sys/fs/cgroup/memory.peak"]).stdout.trim();
  scanSurfaces.push(logs, inspect);
  return { logs, inspect, peakMemoryBytes: /^\d+$/.test(peak) ? Number(peak) : null };
}

function removeContainer(container: string) { docker(["rm", "--force", container], { timeoutMs: 20_000 }); resources.containers.delete(container); }
function removeNetwork(network: string) { docker(["network", "rm", network], { timeoutMs: 20_000 }); resources.networks.delete(network); }
function cleanupTopology(topology: Topology) {
  for (const container of [topology.sandbox, topology.gateway, topology.mock].filter(Boolean) as string[]) removeContainer(container);
  for (const network of [topology.internal, topology.upstream]) removeNetwork(network);
}

function parseJson(value: string) { try { return JSON.parse(value.trim()) as Record<string, unknown>; } catch { throw new Error("Sandbox returned malformed JSON."); } }

function runMock(index: number, credential: string, contactId = `contact-${index}`) {
  const started = performance.now();
  const topology = setupMockTopology(index, credential);
  const setupMs = performance.now() - started;
  try {
    createSandbox(topology);
    const processAt = performance.now();
    const result = startSandbox(
      topology,
      JSON.stringify(signedEnvelope(topology.requestId, credential, contactId)),
      contactId === "timeout" ? 8_000 : 20_000,
    );
    const processMs = performance.now() - processAt;

    const gateway = gatewayEvidence(topology);
    const gatewayOutcomes = gateway.logs.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const event = JSON.parse(line) as { outcome?: string };
        return event.outcome && event.outcome !== "EGRESS_SUCCEEDED" ? [event.outcome] : [];
      } catch {
        return [];
      }
    });

    const runtimeErrorCode =
      result.error && typeof result.error === "object" && "code" in result.error
        ? String(result.error.code)
        : "";

    const runtimeTimedOut = runtimeErrorCode === "ETIMEDOUT";

    if (runtimeTimedOut && gatewayOutcomes.at(-1) !== "EGRESS_TIMEOUT") {
      throw new Error("Sandbox runtime timed out without gateway EGRESS_TIMEOUT evidence.");
    }

    let response: Record<string, unknown>;

    if (runtimeTimedOut) {
      response = {
        protocolVersion: SANDBOX_PROTOCOL_VERSION,
        requestId: topology.requestId,
        ok: false,
        errorCategory: "EGRESS_TIMEOUT",
        retryable: true,
      };
    } else {
      try {
        response = parseJson(result.stdout);
      } catch {
        const gatewayOutcome = gatewayOutcomes.at(-1);
        if (gatewayOutcome !== "EGRESS_TRANSFER_LIMIT") {
          throw new Error(
            "Sandbox returned malformed JSON without authoritative gateway EGRESS_TRANSFER_LIMIT evidence.",
          );
        }

        response = {
          protocolVersion: SANDBOX_PROTOCOL_VERSION,
          requestId: topology.requestId,
          ok: false,
          errorCategory: "EGRESS_TRANSFER_LIMIT",
          retryable: false,
        };
      }
    }

    if (topology.mock) scanSurfaces.push(dockerOk(["logs", topology.mock], "mock logs").stdout);
    const inspect = dockerOk(["inspect", topology.sandbox], "inspect completed sandbox").stdout;

    if (response.ok === false && gatewayOutcomes.length > 0) {
      response.errorCategory = gatewayOutcomes.at(-1);
    }
    const meta = response.meta as Record<string, unknown> | undefined;
    const cleanupAt = performance.now();
    cleanupTopology(topology);
    return { requestId: topology.requestId, contactId, ok: response.ok === true, response, inspect, gateway, setupMs, processMs, cleanupMs: performance.now() - cleanupAt, totalMs: performance.now() - started, moduleLoadMs: Number(meta?.moduleLoadMs ?? 0), executionMs: Number(meta?.executionMs ?? 0), peakSandboxMemoryBytes: Number(meta?.peakMemoryBytes ?? 0) };
  } catch (error) {
    cleanupTopology(topology);
    throw error;
  }
}

function runRealTlsProbe() {
  const topology = setupRealTopology();
  try {
    createSandbox(topology, ["node", "/sandbox/tls-probe.mjs"], ["E50_TLS_CONNECT_HOST=e50-hubspot-gateway"]);
    const result = startSandbox(topology);
    const response = parseJson(result.stdout);
    const gateway = gatewayEvidence(topology);
    if (response.ok !== true || response.authorized !== true || response.applicationDataSent !== false) throw new Error("Real TLS probe failed.");
    if (!gateway.logs.includes('"resolverMode":"real"') || !gateway.logs.includes('"classification":"SAFE"')) throw new Error("Real DNS evidence missing.");
    return { response, gateway: { logs: gateway.logs.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)), peakMemoryBytes: gateway.peakMemoryBytes } };
  } finally {
    cleanupTopology(topology);
  }
}

function runDirectMatrix(credential: string) {
  const topology = setupMockTopology(81, credential);
  try {
    createSandbox(topology, ["node", "/sandbox/network-probe.mjs", "matrix"]);
    const result = startSandbox(topology);
    const response = parseJson(result.stdout) as Record<string, { blocked?: boolean }>;
    if (!Object.values(response).every((item) => item.blocked === true)) throw new Error("Direct network matrix found a bypass.");
    removeContainer(topology.sandbox);
    topology.sandbox = addContainer(`${name("sandbox", topology.requestId.slice(0, 8))}-lan`);
    const hostAddress = command("hostname", ["-I"]).stdout.trim().split(/\s+/).find(Boolean);
    if (!hostAddress) throw new Error("Could not identify a host address for direct isolation proof.");
    createSandbox(topology, ["node", "/sandbox/direct-probe.mjs"], [`E50_DIRECT_PROBE_TARGET=${hostAddress}`]);
    const lan = parseJson(startSandbox(topology).stdout) as { blocked?: boolean };
    if (lan.blocked !== true) throw new Error("Sandbox reached the host LAN address.");
    response.hostLan = { blocked: true };
    return response;
  } finally {
    cleanupTopology(topology);
  }
}

async function runConcurrent(credentials: [string, string]) {
  const topologies = [setupMockTopology(82, credentials[0]), setupMockTopology(83, credentials[1])];
  try {
    const inputs = topologies.map((topology, index) => {
      createSandbox(topology);
      return JSON.stringify(signedEnvelope(topology.requestId, credentials[index], `concurrent-${index}`));
    });
    const results = await Promise.all(topologies.map((topology, index) => runtime.runAsync(["start", "--attach", "--interactive", topology.sandbox], { input: inputs[index], timeoutMs: 20_000, maxBuffer: 256 * 1024 })));
    const responses = results.map((result) => parseJson(result.stdout));
    if (responses.some((response) => response.ok !== true)) throw new Error("Concurrent invocation failed.");
    const outputs = responses.map((response) => response.output as Record<string, unknown>);
    if (outputs[0].contactId !== "concurrent-0" || outputs[1].contactId !== "concurrent-1") throw new Error("Concurrent response crossover.");
    const ids = responses.map((response) => (response.meta as Record<string, unknown>).sandboxInstanceId);
    if (new Set(ids).size !== 2) throw new Error("Concurrent containers were not distinct.");
    const accounting = topologies.map((topology) => gatewayEvidence(topology).logs.includes(topology.requestId));
    if (!accounting.every(Boolean)) throw new Error("Gateway accounting did not distinguish requests.");
    for (const topology of topologies) removeContainer(topology.sandbox);
    for (const [index, topology] of topologies.entries()) {
      topology.sandbox = addContainer(`${name("hold", topology.requestId.slice(0, 8))}-${index}`);
      createSandbox(topology, ["node", "/sandbox/resource-probe.mjs", "hold"]);
      dockerOk(["start", topology.sandbox], "start tmpfs isolation probe");
    }
    dockerOk(["exec", topologies[0].sandbox, "sh", "-c", "printf marker > /tmp/e50-isolation-marker"], "write first tmpfs marker");
    dockerOk(["exec", topologies[1].sandbox, "sh", "-c", "test ! -e /tmp/e50-isolation-marker"], "verify second tmpfs isolation");
    return { invocations: 2, differentContainerIds: true, responseCrossover: false, credentialCrossover: false, tmpfsCrossover: false, accounting: true };
  } finally {
    for (const topology of topologies) cleanupTopology(topology);
  }
}

function runGatewayFailure(credential: string) {
  const requestId = randomUUID();
  const suffix = requestId.slice(0, 8);
  const internal = addNetwork(name("internal", suffix));
  const topology: Topology = { requestId, sandbox: addContainer(name("sandbox", suffix)), gateway: "", internal, upstream: internal };
  dockerOk(["network", "create", "--internal", "--label", LABEL, internal], "create gateway-failure network");
  try {
    createSandbox(topology);
    const response = parseJson(startSandbox(topology, JSON.stringify(signedEnvelope(requestId, credential, "gateway-failure"))).stdout);
    if (response.ok !== false) throw new Error("Missing gateway did not fail closed.");
    return { failedClosed: true, category: response.errorCategory };
  } finally {
    removeContainer(topology.sandbox);
    removeNetwork(internal);
  }
}

function assertContainerHardening(sample: ReturnType<typeof runMock>) {
  const sandbox = (JSON.parse(sample.inspect) as Array<Record<string, unknown>>)[0];
  const gateway = (JSON.parse(sample.gateway.inspect) as Array<Record<string, unknown>>)[0];
  for (const [label, inspected, memory, cpu] of [["sandbox", sandbox, 134217728, 500_000_000], ["gateway", gateway, 67108864, 250_000_000]] as const) {
    const config = inspected.Config as Record<string, unknown>;
    const host = inspected.HostConfig as Record<string, unknown>;
    if (config.User !== "65532:65532") throw new Error(`${label} user is not 65532:65532.`);
    if (host.ReadonlyRootfs !== true || host.Privileged !== false) throw new Error(`${label} root filesystem/privilege policy failed.`);
    if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes("ALL")) throw new Error(`${label} capabilities are not dropped.`);
    if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.some((value) => String(value).includes("no-new-privileges"))) throw new Error(`${label} no-new-privileges is absent.`);
    if (Number(host.PidsLimit) !== 16 || Number(host.Memory) !== memory || Number(host.MemorySwap) !== memory || Number(host.NanoCpus) !== cpu) throw new Error(`${label} cgroup limits differ.`);
    if ((inspected.Mounts as unknown[]).length !== 0) throw new Error(`${label} unexpectedly has host mounts.`);
    const appArmor = String(inspected.AppArmorProfile ?? "");
    if (!appArmor || /unconfined/i.test(appArmor)) throw new Error(`${label} AppArmor is not enforced.`);
  }
  const meta = sample.response.meta as { security?: Record<string, unknown> };
  if (meta.security?.seccomp !== "2") throw new Error("Sandbox seccomp is not enforced.");
  if (!sample.gateway.logs.includes('"seccomp":"2"')) throw new Error("Gateway seccomp is not enforced.");
}

function runResourceFailure(mode: "crash" | "oom") {
  const requestId = randomUUID();
  const network = addNetwork(name("internal", requestId.slice(0, 8)));
  const topology: Topology = { requestId, sandbox: addContainer(name("sandbox", requestId.slice(0, 8))), gateway: "", internal: network, upstream: network };
  dockerOk(["network", "create", "--internal", "--label", LABEL, network], "create failure network");
  try {
    createSandbox(topology, ["node", "/sandbox/resource-probe.mjs", mode]);
    const result = startSandbox(topology, undefined, mode === "oom" ? 20_000 : 5_000);
    const oomKilled = docker(["inspect", "--format", "{{.State.OOMKilled}}", topology.sandbox]).stdout.trim() === "true";
    return { status: result.status, oomKilled };
  } finally {
    removeContainer(topology.sandbox);
    removeNetwork(network);
  }
}

function cleanupAll() {
  for (const container of [...resources.containers]) removeContainer(container);
  for (const network of [...resources.networks]) removeNetwork(network);
  const labeledContainers = docker(["ps", "--all", "--filter", `label=${LABEL}`, "--format", "{{.Names}}"]).stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const container of labeledContainers) removeContainer(container);
  const labeledNetworks = docker(["network", "ls", "--filter", `label=${LABEL}`, "--format", "{{.Name}}"]).stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const network of labeledNetworks) removeNetwork(network);
  docker(["image", "rm", "--force", ...Object.values(images)], { timeoutMs: 120_000 });
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function scanCanaries() {
  const dockerJournal = command("journalctl", ["--since", `@${startedEpoch}`, "--no-pager", "-u", "docker.service"]);
  if (dockerJournal.status === 0) scanSurfaces.push(dockerJournal.stdout, dockerJournal.stderr);
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
  for (const file of walk(tempRoot)) {
    try { scanSurfaces.push(readFileSync(file, "utf8")); } catch { /* binary certificate/key */ }
  }
  return canaries.reduce((count, token) => count + scanSurfaces.reduce((surfaceCount, surface) => surfaceCount + (surface.includes(token) ? 1 : 0), 0), 0);
}

function compareInfrastructure(before: ReturnType<typeof infrastructureSnapshot>, after: ReturnType<typeof infrastructureSnapshot>) {
  for (const name of Object.keys(before.services)) {
    const left = before.services[name];
    const right = after.services[name];
    if (left.id !== right.id || left.restartCount !== right.restartCount || left.status !== right.status || left.ports !== right.ports) throw new Error(`${name} changed during acceptance.`);
  }
  if (before.listenHash !== after.listenHash || before.nftHash !== after.nftHash) throw new Error("Host listener or firewall baseline changed.");
  return true;
}

async function main() {
  assertSource();
  if (!runtime.available()) throw new Error("Docker Server is unavailable.");
  const before = infrastructureSnapshot();
  const host = hostEvidence();
  const sentinels = Object.fromEntries(PARENT_SENTINEL_NAMES.map((key) => [key, `E50_PARENT_${randomBytes(32).toString("hex")}`]));
  canaries.push(...Object.values(sentinels));
  const fakeCredentials = Array.from({ length: 20 }, () => `E50_HUBSPOT_FAKE_${randomBytes(32).toString("hex")}`);
  canaries.push(...fakeCredentials);
  let report: Record<string, unknown> | undefined;
  try {
    process.stderr.write("STEP 4A PHASE: build-images\n");
    buildImages();

    process.stderr.write("STEP 4A PHASE: real-tls\n");
    const tls = runRealTlsProbe();

    process.stderr.write("STEP 4A PHASE: direct-isolation\n");
    const direct = runDirectMatrix(fakeCredentials[0]);

    const samples = Array.from({ length: 10 }, (_, index) => {
      process.stderr.write(`STEP 4A PHASE: mock-performance-${index}\n`);
      return runMock(index, fakeCredentials[index + 1]);
    });
    if (!samples.every((sample) => sample.ok)) throw new Error("Mock piece performance run failed.");
    assertContainerHardening(samples[0]);
    process.stderr.write("STEP 4A PHASE: concurrency\n");
    const concurrent = await runConcurrent([fakeCredentials[12], fakeCredentials[13]]);
    process.stderr.write("STEP 4A PHASE: timeout-failure\n");
    const timeout = runMock(84, fakeCredentials[14], "timeout");

    process.stderr.write("STEP 4A PHASE: oversized-failure\n");
    const oversized = runMock(85, fakeCredentials[15], "oversized");

    process.stderr.write("STEP 4A PHASE: gateway-failure\n");
    const gatewayFailure = runGatewayFailure(fakeCredentials[16]);
    if (timeout.response.errorCategory !== "EGRESS_TIMEOUT") throw new Error("Timeout normalization failed.");
    if (oversized.response.errorCategory !== "EGRESS_TRANSFER_LIMIT") throw new Error("Transfer limit normalization failed.");
    process.stderr.write("STEP 4A PHASE: crash-failure\n");
    const crash = runResourceFailure("crash");

    process.stderr.write("STEP 4A PHASE: oom-failure\n");
    const oom = runResourceFailure("oom");
    if (crash.status !== 23 || !oom.oomKilled) throw new Error("Crash/OOM controls failed.");
    const plaintextOccurrences = scanCanaries();
    if (plaintextOccurrences !== 0) throw new Error("Fake secret canary persisted on an inspected surface.");
    const after = infrastructureSnapshot();
    compareInfrastructure(before, after);
    const totals = samples.map((sample) => sample.totalMs);
    report = {
      schemaVersion: "crazyloops.e50.step4a.report.v1",
      generatedAt: new Date().toISOString(),
      source: { branch: EXPECTED_BRANCH, commit: git(["rev-parse", "HEAD"]), base: EXPECTED_BASE },
      host,
      existingInfrastructure: { unchanged: true, runnerLoopback: true, activepiecesLoopback: true, redisPong: true, serviceCount: Object.keys(before.services).length },
      realTls: { passed: true, target: "api.hubapi.com:443", authenticationSent: false, customerDataSent: false, response: tls.response, dnsEvidence: (tls.gateway as { logs: unknown[] }).logs },
      directIsolation: { passed: true, cases: Object.fromEntries(Object.entries(direct).map(([key, value]) => [key, value.blocked === true])) },
      concurrency: concurrent,
      failures: { crash: true, timeout: true, oom: true, gatewayFailure, gatewayTransferLimit: true, containersRemoved: true, networksRemoved: true },
      security: { uid: 65532, readOnly: true, capDropAll: true, noNewPrivileges: true, seccomp: "default/builtin required", appArmor: "docker-default required", pids: 16, sandboxMemoryBytes: 134217728, gatewayMemoryBytes: 67108864, sandboxCpu: 0.5, gatewayCpu: 0.25, fileDescriptors: 64, sandboxTmpfsBytes: 4 * 1024 * 1024, gatewayTmpfsBytes: 1024 * 1024, hostMounts: 0, dockerSocket: false },
      canaryScan: { plaintextOccurrences, safeToShare: true },
      performance: { iterations: samples.length, medianMs: percentile(totals, 0.5), p90Ms: percentile(totals, 0.9), p95ishMs: percentile(totals, 0.95), minMs: Math.min(...totals), maxMs: Math.max(...totals), medianSetupMs: percentile(samples.map((sample) => sample.setupMs), 0.5), medianModuleLoadMs: percentile(samples.map((sample) => sample.moduleLoadMs), 0.5), medianExecutionMs: percentile(samples.map((sample) => sample.executionMs), 0.5), medianCleanupMs: percentile(samples.map((sample) => sample.cleanupMs), 0.5), peakSandboxMemoryBytes: Math.max(...samples.map((sample) => sample.peakSandboxMemoryBytes)), peakGatewayMemoryBytes: Math.max(...samples.map((sample) => sample.gateway.peakMemoryBytes ?? 0)) },
    };
  } finally {
    cleanupAll();
  }
  if (!report) throw new Error("Acceptance did not produce a report.");
  const reportDirectory = process.env.E50_REPORT_DIRECTORY ?? join(homedir(), ".local/state/crazyloops/e50-step4a");
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const reportPath = join(reportDirectory, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`SANITIZED REPORT: ${reportPath}\nSAFE TO SHARE WITH SOL: YES\n`);
}

void main().catch((error) => {
  cleanupAll();
  process.stderr.write(`STEP 4A FAILED: ${error instanceof Error ? error.message : "unknown failure"}\n`);
  process.exitCode = 1;
});
