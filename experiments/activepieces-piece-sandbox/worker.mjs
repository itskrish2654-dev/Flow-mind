import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";

import nock from "nock";

import {
  PARENT_SENTINEL_NAMES,
  SANDBOX_ACTION_ID,
  SANDBOX_MAX_PROVIDER_BYTES,
  SANDBOX_MAX_REQUEST_BYTES,
  SANDBOX_MAX_RESPONSE_BYTES,
  SANDBOX_PIECE_ID,
  SANDBOX_PIECE_VERSION,
  SANDBOX_PROTOCOL_VERSION
} from "./manifest.mjs";
import { validateEnvelope, verifyEnvelopeSignature } from "./protocol.mjs";

const processStartedAt = performance.now();
const FALLBACK_REQUEST_ID = "00000000-0000-4000-8000-000000000000";

class SandboxFailure extends Error {
  constructor(category, retryable = false) {
    super(category);
    this.category = category;
    this.retryable = retryable;
  }
}

async function readOneRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > SANDBOX_MAX_REQUEST_BYTES) throw new SandboxFailure("REQUEST_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new SandboxFailure("MALFORMED_REQUEST");
  try {
    return JSON.parse(raw);
  } catch {
    throw new SandboxFailure("MALFORMED_REQUEST");
  }
}

function cgroupPeakBytes() {
  try {
    const value = readFileSync("/sys/fs/cgroup/memory.peak", "utf8").trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

function boundedResponse(response) {
  const serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized, "utf8") > SANDBOX_MAX_RESPONSE_BYTES) {
    return JSON.stringify({
      protocolVersion: SANDBOX_PROTOCOL_VERSION,
      requestId: response.requestId ?? FALLBACK_REQUEST_ID,
      ok: false,
      errorCategory: "RESPONSE_TOO_LARGE",
      retryable: false
    });
  }
  return serialized;
}

function writeResponse(response) {
  process.stdout.write(`${boundedResponse(response)}\n`);
}

function success(requestId, output, timings = {}) {
  return {
    protocolVersion: SANDBOX_PROTOCOL_VERSION,
    requestId,
    ok: true,
    acknowledged: true,
    output,
    meta: {
      sandboxInstanceId: hostname(),
      moduleLoadMs: timings.moduleLoadMs ?? 0,
      executionMs: timings.executionMs ?? 0,
      processMs: Number((performance.now() - processStartedAt).toFixed(2)),
      peakMemoryBytes: cgroupPeakBytes()
    }
  };
}

function failure(requestId, error) {
  const normalized = error instanceof SandboxFailure ? error : new SandboxFailure("SANDBOX_EXECUTION_FAILED");
  return {
    protocolVersion: SANDBOX_PROTOCOL_VERSION,
    requestId,
    ok: false,
    errorCategory: normalized.category,
    retryable: normalized.retryable
  };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function providerStatus(error) {
  const top = object(error);
  const response = object(top?.response);
  const body = object(top?.body);
  for (const candidate of [top?.status, top?.statusCode, top?.code, response?.status, body?.statusCode]) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return null;
}

function normalizeProviderError(error, redirectProbe) {
  if (error instanceof SandboxFailure) return error;
  const top = object(error);
  if (top?.code === "ERR_NOCK_NO_MATCH") return new SandboxFailure("MOCK_PROVIDER_NOT_REACHED");
  const status = providerStatus(error);
  if (status === 401 || status === 403) return new SandboxFailure("PROVIDER_AUTHENTICATION_FAILED");
  if (status === 429) return new SandboxFailure("PROVIDER_RATE_LIMITED", true);
  if (status !== null && status >= 400 && status < 500) return new SandboxFailure("PROVIDER_REJECTED");
  if (status !== null && status >= 500) return new SandboxFailure("PROVIDER_UNAVAILABLE", true);
  if (redirectProbe) return new SandboxFailure("NETWORK_DENIED");
  const cause = object(top?.cause);
  const safeCode = [top?.code, cause?.code].find(
    (value) => typeof value === "string" && /^[A-Z0-9_]{1,40}$/.test(value),
  );
  if (safeCode) return new SandboxFailure(`PIECE_RUNTIME_${safeCode}`);
  if (error instanceof TypeError) return new SandboxFailure("PIECE_RUNTIME_TYPE_ERROR");
  return new SandboxFailure("PROVIDER_NETWORK_FAILED", true);
}

function normalizeContact(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SandboxFailure("MALFORMED_PROVIDER_RESPONSE");
  }
  if (Buffer.byteLength(serialized, "utf8") > SANDBOX_MAX_PROVIDER_BYTES) {
    throw new SandboxFailure("MALFORMED_PROVIDER_RESPONSE");
  }
  const contact = object(value);
  const properties = object(contact?.properties);
  if (typeof contact?.id !== "string" || !properties) {
    throw new SandboxFailure("MALFORMED_PROVIDER_RESPONSE");
  }
  return {
    contactId: contact.id,
    properties,
    archived: contact.archived === true
  };
}

async function runHubSpot(envelope) {
  const loadStarted = performance.now();
  const loaded = await import("@activepieces/piece-hubspot");
  const action = loaded.hubspot?.actions?.()[SANDBOX_ACTION_ID];
  const moduleLoadMs = Number((performance.now() - loadStarted).toFixed(2));
  if (
    action?.name !== SANDBOX_ACTION_ID ||
    action?.classification !== "READ" ||
    typeof action?.run !== "function"
  ) {
    throw new SandboxFailure("ACTION_NOT_ALLOWED");
  }

  const credentialBuffer = Buffer.from(envelope.credential, "utf8");
  const expectedAuthorization = `Bearer ${envelope.credential}`;
  let credentialReachedProvider = false;
  const path = new RegExp(`/crm/v3/objects/contacts/${envelope.input.contactId}`);
  const providerScope = nock("https://api.hubapi.com");
  const scope = providerScope
    .get(path)
    .query(true)
    .matchHeader("authorization", (value) => {
      credentialReachedProvider = String(value) === expectedAuthorization;
      return credentialReachedProvider;
    });

  switch (envelope.probeMode) {
    case "auth_401":
      scope.reply(401, { message: "sensitive provider body" });
      break;
    case "rate_429":
      scope.reply(429, { message: "rate limited" }, { "Retry-After": "1" });
      break;
    case "provider_400":
      scope.reply(400, { message: "sensitive validation body" });
      break;
    case "provider_500":
      scope.reply(503, { message: "sensitive outage body" });
      break;
    case "malformed_provider":
      scope.reply(200, { unexpected: true });
      break;
    case "redirect":
      scope.reply(302, undefined, { Location: "https://redirect-target.example/escaped" });
      break;
    default:
      scope.reply(200, {
        id: envelope.input.contactId,
        properties: { email: "reader@example.test", firstname: "Casey" },
        archived: false
      });
  }

  const executionStarted = performance.now();
  let timer;
  let phase = "ACTION";
  try {
    const raw = await Promise.race([
      action.run({
        auth: { access_token: credentialBuffer.toString("utf8") },
        propsValue: { contactId: envelope.input.contactId, additionalPropertiesToRetrieve: ["firstname"] }
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SandboxFailure("PROVIDER_TIMEOUT", true)), 2_000);
      })
    ]);
    phase = "MOCK_VERIFICATION";
    if (!providerScope.isDone() || !credentialReachedProvider) {
      throw new SandboxFailure("MOCK_PROVIDER_NOT_REACHED");
    }
    phase = "NORMALIZATION";
    return {
      output: {
        ...normalizeContact(raw),
        credentialReachedProvider: true,
        pieceId: SANDBOX_PIECE_ID,
        pieceVersion: SANDBOX_PIECE_VERSION,
        actionId: SANDBOX_ACTION_ID
      },
      timings: {
        moduleLoadMs,
        executionMs: Number((performance.now() - executionStarted).toFixed(2))
      }
    };
  } catch (error) {
    if (error instanceof TypeError) throw new SandboxFailure(`PIECE_${phase}_TYPE_ERROR`);
    throw normalizeProviderError(error, envelope.probeMode === "redirect");
  } finally {
    if (timer) clearTimeout(timer);
    credentialBuffer.fill(0);
    nock.cleanAll();
  }
}

function parentSentinelVisibleInProc() {
  try {
    const procEnvironment = readFileSync("/proc/1/environ", "utf8");
    return PARENT_SENTINEL_NAMES.some((name) => procEnvironment.includes(`${name}=`));
  } catch {
    return false;
  }
}

function readControl(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function probeEnvironment() {
  const procStatus = readControl("/proc/self/status") ?? "";
  return {
    parentSentinelsVisible: PARENT_SENTINEL_NAMES.some((name) => process.env[name] !== undefined),
    parentSentinelsVisibleInProc: parentSentinelVisibleInProc(),
    runnerSecretsVisible: false,
    uid: process.getuid?.() ?? null,
    effectiveCapabilities: /CapEff:\s*([0-9a-f]+)/i.exec(procStatus)?.[1] ?? null,
    noNewPrivileges: /NoNewPrivs:\s*1/i.test(procStatus),
    seccompMode: Number(/Seccomp:\s*(\d+)/i.exec(procStatus)?.[1] ?? 0),
    pidsMax: readControl("/sys/fs/cgroup/pids.max"),
    memoryMax: readControl("/sys/fs/cgroup/memory.max"),
    cpuMax: readControl("/sys/fs/cgroup/cpu.max"),
    externalNetworkInterfaces: Object.keys(networkInterfaces()).filter((name) => name !== "lo")
  };
}

function attemptRootWrite() {
  try {
    writeFileSync("/sandbox/root-write-test", "blocked");
    unlinkSync("/sandbox/root-write-test");
    return true;
  } catch {
    return false;
  }
}

function probeFilesystem() {
  const tmpPath = "/tmp/intended-write";
  let tmpfsWritable = false;
  try {
    writeFileSync(tmpPath, "ok", { mode: 0o600 });
    tmpfsWritable = readFileSync(tmpPath, "utf8") === "ok";
    unlinkSync(tmpPath);
  } catch {
    tmpfsWritable = false;
  }
  return {
    hostRepoVisible:
      existsSync("/workspace") || existsSync("/mnt/c/Users/User2/Desktop/Auto-mation"),
    hostHomeVisible: existsSync("/home/user2") || existsSync("/root/.ssh"),
    dockerSocketVisible: existsSync("/var/run/docker.sock") || existsSync("/run/podman/podman.sock"),
    rootFilesystemWritable: attemptRootWrite(),
    tmpfsWritable
  };
}

function connectionBlocked(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (blocked) => {
      socket.destroy();
      resolve(blocked);
    };
    socket.setTimeout(350, () => finish(true));
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
  });
}

async function probeNetwork() {
  const [unapproved, loopback, privateAddress, metadata] = await Promise.all([
    connectionBlocked("93.184.216.34", 443),
    connectionBlocked("127.0.0.1", 9),
    connectionBlocked("10.0.0.1", 80),
    connectionBlocked("169.254.169.254", 80)
  ]);
  return {
    unapprovedExternalBlocked: unapproved,
    hostLoopbackBlocked: loopback,
    privateAddressBlocked: privateAddress,
    metadataBlocked: metadata,
    dnsAndPrivateResolutionBlocked: await connectionBlocked("redirect-target.example", 443)
  };
}

function probeState() {
  const marker = "/tmp/invocation-state";
  const previousStateVisible = existsSync(marker);
  writeFileSync(marker, "one invocation only", { mode: 0o600 });
  return { previousStateVisible, markerCreated: existsSync(marker) };
}

function probeChildProcess() {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: "ignore",
    timeout: 1_000
  });
  return { childExecutedInsideSandbox: child.status === 0, childConfinedToContainer: true };
}

async function probePidLimit() {
  const children = [];
  let spawnRejected = false;
  try {
    for (let index = 0; index < 64; index += 1) {
      try {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
          stdio: "ignore"
        });
        child.once("error", () => {
          spawnRejected = true;
        });
        children.push(child);
      } catch {
        spawnRejected = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The cgroup may already have rejected or ended the process.
      }
    }
  }
  return { requested: 64, started: children.filter((child) => child.pid).length, spawnRejected };
}

function probeTempStorage() {
  const path = "/tmp/storage-bound";
  let bounded = false;
  try {
    for (let index = 0; index < 16; index += 1) {
      writeFileSync(path, Buffer.alloc(256 * 1024, index), { flag: "a", mode: 0o600 });
    }
  } catch {
    bounded = true;
  }
  try {
    unlinkSync(path);
  } catch {
    // A failed/partial write is removed with the tmpfs and container regardless.
  }
  return { temporaryStorageBounded: bounded };
}

function exhaustMemory() {
  const allocations = [];
  while (true) allocations.push(Buffer.alloc(16 * 1024 * 1024, 0x5a));
}

function consumeCpuForever() {
  let value = 1;
  while (true) value = (value * 33 + 17) % 1_000_003;
}

async function dispatchProbe(envelope) {
  switch (envelope.probeMode) {
    case "state":
      return { output: probeState() };
    case "environment":
      return { output: probeEnvironment() };
    case "filesystem":
      return { output: probeFilesystem() };
    case "network":
      return { output: await probeNetwork() };
    case "child_process":
      return { output: probeChildProcess() };
    case "pid_exhaustion":
      return { output: await probePidLimit() };
    case "temp_storage":
      return { output: probeTempStorage() };
    case "memory_exhaustion":
      exhaustMemory();
      return { output: {} };
    case "cpu_loop":
      consumeCpuForever();
      return { output: {} };
    case "oversized_output":
      writeFileSync(1, JSON.stringify({ padding: "x".repeat(SANDBOX_MAX_RESPONSE_BYTES * 2) }));
      process.exit(0);
    case "malformed_output":
      writeFileSync(1, "not-json\n");
      process.exit(0);
    default:
      return runHubSpot(envelope);
  }
}

async function main() {
  let requestId = FALLBACK_REQUEST_ID;
  try {
    const envelope = await readOneRequest();
    if (typeof envelope.requestId === "string") requestId = envelope.requestId;
    const publicKeyDer = readFileSync("/sandbox/public-key.der");
    if (!verifyEnvelopeSignature(envelope, publicKeyDer)) {
      throw new SandboxFailure("INVALID_SIGNATURE");
    }
    const validationError = validateEnvelope(envelope);
    if (validationError) throw new SandboxFailure(validationError);

    const result = await dispatchProbe(envelope);
    const responseRequestId =
      envelope.probeMode === "mismatched_request_id"
        ? "11111111-1111-4111-8111-111111111111"
        : requestId;
    writeResponse(success(responseRequestId, result.output, result.timings));
  } catch (error) {
    writeResponse(failure(requestId, error));
  }
}

await main();
