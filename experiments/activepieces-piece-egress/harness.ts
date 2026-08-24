import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PARENT_SENTINEL_NAMES,
  SANDBOX_ACTION_ID,
  SANDBOX_CAPABILITY_ID,
  SANDBOX_CAPABILITY_VERSION,
  SANDBOX_MAX_REQUEST_BYTES,
  SANDBOX_MAX_RESPONSE_BYTES,
  SANDBOX_PIECE_ID,
  SANDBOX_PIECE_VERSION,
  SANDBOX_PROTOCOL_VERSION,
} from "../activepieces-piece-sandbox/manifest.mjs";
import { canonicalJson, validateEnvelope } from "../activepieces-piece-sandbox/protocol.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const STEP_TWO_DIRECTORY = join(dirname(DIRECTORY), "activepieces-piece-sandbox");
const RUNTIME_DIRECTORY = mkdtempSync(join(tmpdir(), "crazyloops-e50-egress-"));
const LABEL = "crazyloops.experiment=e50-piece-egress";
const BASE_IMAGE = "localhost/crazyloops-e50-piece-egress";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }) as Buffer;
const fingerprint = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
const images = {
  sandbox: `${BASE_IMAGE}-sandbox:${fingerprint}`,
  gateway: `${BASE_IMAGE}-gateway:${fingerprint}`,
  mock: `${BASE_IMAGE}-mock:${fingerprint}`,
};
let imagesReady = false;

process.once("beforeExit", () => {
  setTimeout(() => {
    rmSync(RUNTIME_DIRECTORY, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }, 250);
});

export type EgressScenario =
  | "safe"
  | "dns_failure"
  | "private"
  | "metadata"
  | "ipv6_private"
  | "rebind";

type Envelope = {
  protocolVersion: string;
  requestId: string;
  capabilityId: string;
  capabilityVersion: string;
  pieceId: string;
  pieceVersion: string;
  actionId: string;
  input: { contactId: string };
  credential: string;
  probeMode: "normal";
  signature?: string;
};

export type GatewayEvent = {
  event: string;
  outcome?: string;
  requestId?: string;
  durationMs?: number;
  upstreamBytes?: number;
  downstreamBytes?: number;
  uid?: number;
  seccomp?: string;
  capabilities?: string;
  noNewPrivileges?: string;
};

export type EgressInvocation = {
  requestId: string;
  response: Record<string, unknown>;
  gatewayEvents: GatewayEvent[];
  gatewayLogs: string;
  gatewayInspect: string;
  gatewayDiff: string;
  sandboxStdout: string;
  sandboxStderr: string;
  totalMs: number;
  networkSetupMs: number;
  mockStartupMs: number;
  gatewayStartupMs: number;
  sandboxProcessMs: number;
  cleanupMs: number;
  sandboxPeakMemoryBytes: number | null;
  gatewayPeakMemoryBytes: number | null;
  containersRemoved: boolean;
  networksRemoved: boolean;
};

type PodmanResult = SpawnSyncReturns<string>;

function windowsToWsl(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function run(command: string, args: string[], options: { input?: string; timeout?: number; cwd?: string; maxBuffer?: number } = {}) {
  const executable = process.platform === "win32" && command === "podman" ? "wsl.exe" : command;
  const commandArgs = process.platform === "win32" && command === "podman" ? ["-d", "Ubuntu", "--", "podman", ...args] : args;
  return spawnSync(executable, commandArgs, {
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 60_000,
    cwd: options.cwd ?? DIRECTORY,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    windowsHide: true,
  });
}

function podman(args: string[], options: { input?: string; timeout?: number; maxBuffer?: number } = {}) {
  return run("podman", args, options);
}

function openssl(args: string[]) {
  if (process.platform !== "win32") return run("openssl", args);
  return spawnSync("wsl.exe", ["-d", "Ubuntu", "--", "openssl", ...args.map(windowsToWsl)], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: RUNTIME_DIRECTORY,
    windowsHide: true,
  });
}

function requireSuccess(result: PodmanResult, operation: string) {
  if (result.status !== 0) throw new Error(`${operation} failed (${result.status ?? "no status"}): ${result.stderr.slice(0, 500)}`);
}

export function runtimeAvailable() {
  const result = podman(["info", "--format", "{{.Host.Security.Rootless}}"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

function generateCertificates(context: string) {
  const caKey = join(context, "ca.key");
  const caCert = join(context, "ca.crt");
  const serverKey = join(context, "server.key");
  const serverCsr = join(context, "server.csr");
  const serverCert = join(context, "server.crt");
  requireSuccess(openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", caKey]), "generate test CA key");
  requireSuccess(openssl(["req", "-x509", "-new", "-key", caKey, "-sha256", "-days", "1", "-subj", "/CN=CrazyLoops E50 Test CA", "-out", caCert]), "generate test CA certificate");
  requireSuccess(openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", serverKey]), "generate mock key");
  requireSuccess(openssl(["req", "-new", "-key", serverKey, "-subj", "/CN=api.hubapi.com", "-addext", "subjectAltName=DNS:api.hubapi.com", "-out", serverCsr]), "generate mock CSR");
  requireSuccess(openssl(["x509", "-req", "-in", serverCsr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-sha256", "-copy_extensions", "copy", "-out", serverCert]), "sign mock certificate");
  return { caCert, serverKey, serverCert };
}

export function ensureImages() {
  if (imagesReady) return images;
  if (!runtimeAvailable()) throw new Error("Rootless Podman is required.");
  const buildRoot = join(RUNTIME_DIRECTORY, "build");
  const sandboxContext = join(buildRoot, "sandbox");
  const mockContext = join(buildRoot, "mock");
  mkdirSync(sandboxContext, { recursive: true });
  mkdirSync(mockContext, { recursive: true });
  try {
    const certificates = generateCertificates(buildRoot);
    for (const file of ["package.json", "package-lock.json", "manifest.mjs", "protocol.mjs"]) copyFileSync(join(STEP_TWO_DIRECTORY, file), join(sandboxContext, file));
    for (const file of ["worker.mjs", "network-probe.mjs"]) copyFileSync(join(DIRECTORY, file), join(sandboxContext, file));
    copyFileSync(certificates.caCert, join(sandboxContext, "test-ca.crt"));
    copyFileSync(join(DIRECTORY, "Dockerfile.sandbox"), join(sandboxContext, "Dockerfile"));
    copyFileSync(join(DIRECTORY, "mock-provider.mjs"), join(mockContext, "mock-provider.mjs"));
    copyFileSync(certificates.serverCert, join(mockContext, "server.crt"));
    copyFileSync(certificates.serverKey, join(mockContext, "server.key"));
    copyFileSync(join(DIRECTORY, "Dockerfile.mock"), join(mockContext, "Dockerfile"));

    const gatewayBuild = podman(["build", "--pull=never", "--tag", images.gateway, "--label", LABEL, "--file", windowsToWsl(join(DIRECTORY, "Dockerfile.gateway")), windowsToWsl(DIRECTORY)], { timeout: 10 * 60_000 });
    requireSuccess(gatewayBuild, "gateway image build");
    const sandboxBuild = podman(["build", "--pull=never", "--tag", images.sandbox, "--label", LABEL, "--build-arg", `SANDBOX_PUBLIC_KEY_B64=${publicKey.toString("base64")}`, windowsToWsl(sandboxContext)], { timeout: 10 * 60_000 });
    requireSuccess(sandboxBuild, "sandbox image build");
    const mockBuild = podman(["build", "--pull=never", "--tag", images.mock, "--label", LABEL, windowsToWsl(mockContext)], { timeout: 10 * 60_000 });
    requireSuccess(mockBuild, "mock image build");
    imagesReady = true;
    return images;
  } finally {
    rmSync(buildRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function signedEnvelope(requestId: string, credential: string, contactId: string): Envelope {
  const envelope: Envelope = {
    protocolVersion: SANDBOX_PROTOCOL_VERSION,
    requestId,
    capabilityId: SANDBOX_CAPABILITY_ID,
    capabilityVersion: SANDBOX_CAPABILITY_VERSION,
    pieceId: SANDBOX_PIECE_ID,
    pieceVersion: SANDBOX_PIECE_VERSION,
    actionId: SANDBOX_ACTION_ID,
    input: { contactId },
    credential,
    probeMode: "normal",
  };
  const error = validateEnvelope(envelope);
  if (error) throw new Error(`Invalid parent envelope: ${error}`);
  const signature = sign(null, Buffer.from(canonicalJson(envelope), "utf8"), keys.privateKey as KeyObject).toString("base64");
  return { ...envelope, signature };
}

function parseEvents(logs: string) {
  return logs.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as GatewayEvent]; } catch { return []; }
  });
}

function parseResponse(stdout: string, requestId: string) {
  if (Buffer.byteLength(stdout) > SANDBOX_MAX_RESPONSE_BYTES) return { protocolVersion: SANDBOX_PROTOCOL_VERSION, requestId, ok: false, errorCategory: "RESPONSE_TOO_LARGE" };
  try { return JSON.parse(stdout.trim()) as Record<string, unknown>; } catch { return { protocolVersion: SANDBOX_PROTOCOL_VERSION, requestId, ok: false, errorCategory: "MALFORMED_SANDBOX_RESPONSE" }; }
}

function waitForLog(name: string, needle: string) {
  let lastLogs = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const logs = podman(["logs", name], { timeout: 10_000 });
    lastLogs = `${logs.stdout}${logs.stderr}`;
    if (logs.stdout.includes(needle)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`${name} did not become ready: ${lastLogs.slice(0, 500)}`);
}

function removeContainer(name: string) { podman(["rm", "--force", "--ignore", name], { timeout: 20_000 }); }
function removeNetwork(name: string) { podman(["network", "rm", "--force", name], { timeout: 20_000 }); }
function cgroupPeak(name: string) {
  const result = podman(["exec", name, "cat", "/sys/fs/cgroup/memory.peak"], { timeout: 10_000 });
  const value = result.stdout.trim();
  return result.status === 0 && /^\d+$/.test(value) ? Number(value) : null;
}
function absent(kind: "container" | "network", name: string) { return podman([kind, "exists", name]).status !== 0; }

function invokeTopology(options: { credential?: string; contactId?: string; scenario?: EgressScenario; probe?: string }): EgressInvocation {
  ensureImages();
  const requestId = randomUUID();
  const suffix = requestId.slice(0, 8);
  const names = { sandbox: `e50-s-${suffix}`, gateway: `e50-g-${suffix}`, mock: `e50-m-${suffix}`, internal: `e50-i-${suffix}`, upstream: `e50-u-${suffix}` };
  const credential = options.credential ?? `E50_CREDENTIAL_${randomBytes(32).toString("hex")}`;
  const started = performance.now();
  let networkSetupMs = 0;
  let mockStartupMs = 0;
  let gatewayStartupMs = 0;
  let sandboxProcessMs = 0;
  let sandboxStdout = "";
  let sandboxStderr = "";
  let gatewayLogs = "";
  let gatewayInspect = "";
  let gatewayDiff = "";
  let sandboxPeakMemoryBytes: number | null = null;
  let gatewayPeakMemoryBytes: number | null = null;
  let response: Record<string, unknown> = { protocolVersion: SANDBOX_PROTOCOL_VERSION, requestId, ok: false, errorCategory: "EGRESS_CONNECTION_FAILED" };
  let thrown: unknown;
  let cleanupMs = 0;
  let containersRemoved = false;
  let networksRemoved = false;
  const networkAt = performance.now();
  try {
    requireSuccess(podman(["network", "create", "--internal", "--subnet", "10.251.0.0/24", "--label", LABEL, names.internal]), "internal network create");
    requireSuccess(podman(["network", "create", "--internal", "--subnet", "93.184.216.0/24", "--label", LABEL, names.upstream]), "upstream network create");
    networkSetupMs = Number((performance.now() - networkAt).toFixed(2));

    const mockAt = performance.now();
    requireSuccess(podman(["run", "--detach", "--name", names.mock, "--label", LABEL, "--pull=never", "--network", names.upstream, "--ip", "93.184.216.34", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=1m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--pids-limit=16", "--memory=67108864", "--memory-swap=67108864", "--cpus=0.25", "--ulimit=nofile=64:64", "--user=65532:65532", "--env", `E50_EXPECTED_CREDENTIAL_SHA256=${createHash("sha256").update(credential).digest("hex")}`, images.mock]), "mock start");
    mockStartupMs = Number((performance.now() - mockAt).toFixed(2));

    const gatewayAt = performance.now();
    requireSuccess(podman(["run", "--detach", "--name", names.gateway, "--label", LABEL, "--pull=never", "--network", names.upstream, "--ip", "93.184.216.2", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=1m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--sysctl", "net.ipv4.ip_unprivileged_port_start=0", "--pids-limit=16", "--memory=67108864", "--memory-swap=67108864", "--cpus=0.25", "--ulimit=nofile=64:64", "--user=65532:65532", "--env", `E50_REQUEST_ID=${requestId}`, "--env", `E50_RESOLVER_SCENARIO=${options.scenario ?? "safe"}`, images.gateway]), "gateway start");
    requireSuccess(podman(["network", "connect", "--alias", "api.hubapi.com", names.internal, names.gateway]), "gateway network connect");
    waitForLog(names.gateway, "gateway_ready");
    gatewayStartupMs = Number((performance.now() - gatewayAt).toFixed(2));

    gatewayInspect = podman(["inspect", names.gateway]).stdout;
    const sandboxArgs = ["run", "--rm", "--interactive", "--name", names.sandbox, "--label", LABEL, "--pull=never", "--network", names.internal, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=4m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=16", "--memory=134217728", "--memory-swap=134217728", "--cpus=0.5", "--ulimit=nofile=64:64", "--user=65532:65532", "--log-driver=none", "--stop-timeout=1"];
    let input: string | undefined;
    if (options.probe) sandboxArgs.push("--entrypoint=node", images.sandbox, "/sandbox/network-probe.mjs", options.probe);
    else {
      sandboxArgs.push(images.sandbox);
      const envelope = signedEnvelope(requestId, credential, options.contactId ?? "allowed");
      input = JSON.stringify(envelope);
      if (Buffer.byteLength(input) > SANDBOX_MAX_REQUEST_BYTES) throw new Error("request too large");
    }
    const sandboxAt = performance.now();
    const sandbox = podman(sandboxArgs, { input, timeout: 20_000, maxBuffer: SANDBOX_MAX_RESPONSE_BYTES + 1 });
    sandboxProcessMs = Number((performance.now() - sandboxAt).toFixed(2));
    sandboxStdout = sandbox.stdout;
    sandboxStderr = sandbox.stderr;
    response = parseResponse(sandbox.stdout, requestId);
    gatewayPeakMemoryBytes = cgroupPeak(names.gateway);
    const meta = response.meta as { peakMemoryBytes?: number } | undefined;
    sandboxPeakMemoryBytes = meta?.peakMemoryBytes ?? null;
    gatewayLogs = podman(["logs", names.gateway]).stdout;
    gatewayDiff = podman(["diff", names.gateway]).stdout;
    const outcomes = parseEvents(gatewayLogs).map((event) => event.outcome).filter(Boolean) as string[];
    if (response.ok === false) {
      const policyOutcome = [...outcomes].reverse().find((outcome) => outcome !== "EGRESS_SUCCEEDED");
      if (policyOutcome) response.errorCategory = policyOutcome;
    }
  } catch (error) {
    thrown = error;
  } finally {
    if (existsSync(join(RUNTIME_DIRECTORY, "oom"))) rmSync(join(RUNTIME_DIRECTORY, "oom"), { force: true });
    const cleanupAt = performance.now();
    removeContainer(names.sandbox);
    removeContainer(names.gateway);
    removeContainer(names.mock);
    removeNetwork(names.internal);
    removeNetwork(names.upstream);
    cleanupMs = Number((performance.now() - cleanupAt).toFixed(2));
    containersRemoved = absent("container", names.sandbox) && absent("container", names.gateway) && absent("container", names.mock);
    networksRemoved = absent("network", names.internal) && absent("network", names.upstream);
  }
  if (thrown) throw thrown;
  return {
    requestId, response, gatewayEvents: parseEvents(gatewayLogs), gatewayLogs, gatewayInspect, gatewayDiff,
    sandboxStdout, sandboxStderr, totalMs: Number((performance.now() - started).toFixed(2)), networkSetupMs,
    mockStartupMs, gatewayStartupMs, sandboxProcessMs, cleanupMs, sandboxPeakMemoryBytes,
    gatewayPeakMemoryBytes, containersRemoved, networksRemoved,
  };
}

export function invokeAllowed(options: { credential?: string; contactId?: string; scenario?: EgressScenario } = {}) { return invokeTopology(options); }
export function invokeNetworkProbe(probe: string) { return invokeTopology({ probe }); }

export function experimentArtifactCounts() {
  const containers = podman(["ps", "--all", "--filter", `label=${LABEL}`, "--format", "{{.ID}}"]).stdout.trim();
  const networks = podman(["network", "ls", "--filter", `label=${LABEL}`, "--format", "{{.ID}}"]).stdout.trim();
  return { containers: containers ? containers.split(/\r?\n/).length : 0, networks: networks ? networks.split(/\r?\n/).length : 0 };
}

export function gatewayCanaryOccurrences(tokens: string[], invocations: EgressInvocation[]) {
  ensureImages();
  const history = podman(["history", "--no-trunc", images.gateway]);
  const inspect = podman(["image", "inspect", images.gateway]);
  const surfaces = [history.stdout, history.stderr, inspect.stdout, inspect.stderr, ...invocations.flatMap((item) => [item.gatewayLogs, item.gatewayInspect, item.gatewayDiff])];
  return tokens.reduce((count, token) => count + surfaces.reduce((inner, surface) => inner + (surface.includes(token) ? 1 : 0), 0), 0);
}

export function freshParentSentinels() { return Object.fromEntries(PARENT_SENTINEL_NAMES.map((name) => [name, `E50_PARENT_${randomBytes(24).toString("hex")}`])); }

export function cleanupExperiment() {
  const containers = podman(["ps", "--all", "--filter", `label=${LABEL}`, "--format", "{{.Names}}"]).stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const container of containers) removeContainer(container);
  const networks = podman(["network", "ls", "--filter", `label=${LABEL}`, "--format", "{{.Name}}"]).stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const network of networks) removeNetwork(network);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    podman(["image", "rm", "--force", ...Object.values(images)], { timeout: 60_000 });
    if (Object.values(images).every((image) => podman(["image", "exists", image]).status !== 0)) break;
  }
  imagesReady = false;
  rmSync(RUNTIME_DIRECTORY, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function runtimeDirectoryEntries() { return existsSync(RUNTIME_DIRECTORY) ? readdirSync(RUNTIME_DIRECTORY) : []; }
export const egressConstants = { label: LABEL, images, runtimeDirectory: RUNTIME_DIRECTORY };
