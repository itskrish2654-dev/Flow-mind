import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
} from "./manifest.mjs";
import { canonicalJson, validateEnvelope } from "./protocol.mjs";

const EXPERIMENT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IMAGE_REPOSITORY = "localhost/crazyloops-e50-piece-sandbox";
const RUNTIME_LABEL = "crazyloops.experiment=e50-piece-sandbox";
const DEFAULT_TIMEOUT_MS = 30_000;
const RUNTIME_WORKING_DIRECTORY = mkdtempSync(join(tmpdir(), "crazyloops-e50-podman-"));

type ProbeMode =
  | "normal"
  | "state"
  | "environment"
  | "filesystem"
  | "network"
  | "redirect"
  | "child_process"
  | "pid_exhaustion"
  | "temp_storage"
  | "memory_exhaustion"
  | "cpu_loop"
  | "oversized_output"
  | "malformed_output"
  | "mismatched_request_id"
  | "auth_401"
  | "rate_429"
  | "provider_400"
  | "provider_500"
  | "malformed_provider";

type SandboxEnvelope = {
  protocolVersion: string;
  requestId: string;
  capabilityId: string;
  capabilityVersion: string;
  pieceId: string;
  pieceVersion: string;
  actionId: string;
  input: { contactId: string };
  credential: string;
  probeMode: ProbeMode | string;
  signature?: string;
};

export type SandboxResponse = {
  protocolVersion: string;
  requestId: string;
  ok: boolean;
  acknowledged?: boolean;
  output?: Record<string, unknown>;
  errorCategory?: string;
  retryable?: boolean;
  meta?: {
    sandboxInstanceId?: string;
    moduleLoadMs?: number;
    executionMs?: number;
    processMs?: number;
    peakMemoryBytes?: number | null;
  };
};

export type SandboxInvocation = {
  requestId: string;
  response: SandboxResponse;
  totalMs: number;
  cleanupMs: number;
  processStatus: number | null;
  containerRemoved: boolean;
  stdout: string;
  stderr: string;
  containerName: string;
};

type PodmanResult = SpawnSyncReturns<string>;

const signingKeys = generateKeyPairSync("ed25519");
const publicKeyDer = signingKeys.publicKey.export({ format: "der", type: "spki" }) as Buffer;
const publicKeyFingerprint = createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16);
const imageTag = `${IMAGE_REPOSITORY}:${publicKeyFingerprint}`;
let imageReady = false;

function windowsPathToWsl(value: string) {
  const normalized = value.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function podman(args: string[], options: { input?: string; timeout?: number; maxBuffer?: number } = {}) {
  const executable = process.platform === "win32" ? "wsl.exe" : "podman";
  const commandArgs = process.platform === "win32" ? ["-d", "Ubuntu", "--", "podman", ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    encoding: "utf8",
    input: options.input,
    cwd: RUNTIME_WORKING_DIRECTORY,
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    windowsHide: true,
  });
  rmSync(join(RUNTIME_WORKING_DIRECTORY, "oom"), { force: true });
  return result;
}

process.once("beforeExit", () => {
  setTimeout(() => {
    rmSync(RUNTIME_WORKING_DIRECTORY, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }, 250);
});

export function sandboxRuntimeAvailable() {
  const result = podman(["info", "--format", "{{.Host.Security.Rootless}}"], { timeout: 30_000 });
  return result.status === 0 && result.stdout.trim() === "true";
}

export function sandboxRuntimeDescription() {
  const result = podman(["info", "--format", "json"], { timeout: 30_000 });
  if (result.status !== 0) return "unavailable";
  try {
    const info = JSON.parse(result.stdout) as {
      host?: { security?: { rootless?: boolean }; cgroupVersion?: string; ociRuntime?: { name?: string } };
    };
    return `rootless=${info.host?.security?.rootless === true} cgroups=${info.host?.cgroupVersion ?? "unknown"} runtime=${info.host?.ociRuntime?.name ?? "unknown"}`;
  } catch {
    return "unavailable";
  }
}

export function ensureSandboxImage() {
  if (imageReady) return imageTag;
  if (!sandboxRuntimeAvailable()) throw new Error("A rootless Podman runtime is required for this proof.");
  const context = process.platform === "win32" ? windowsPathToWsl(EXPERIMENT_DIRECTORY) : EXPERIMENT_DIRECTORY;
  const build = podman(
    [
      "build",
      "--pull=never",
      "--tag",
      imageTag,
      "--label",
      RUNTIME_LABEL,
      "--build-arg",
      `SANDBOX_PUBLIC_KEY_B64=${publicKeyDer.toString("base64")}`,
      context,
    ],
    { timeout: 10 * 60_000 },
  );
  if (build.status !== 0) {
    throw new Error(`Sandbox image build failed (${build.status ?? "no status"}).`);
  }
  imageReady = true;
  return imageTag;
}

function signEnvelope(envelope: SandboxEnvelope, privateKey: KeyObject = signingKeys.privateKey) {
  const signature = sign(null, Buffer.from(canonicalJson(envelope), "utf8"), privateKey).toString("base64");
  return { ...envelope, signature };
}

function defaultEnvelope(options: {
  credential: string;
  probeMode?: ProbeMode;
  requestId?: string;
  overrides?: Partial<SandboxEnvelope>;
}) {
  const envelope: SandboxEnvelope = {
    protocolVersion: SANDBOX_PROTOCOL_VERSION,
    requestId: options.requestId ?? randomUUID(),
    capabilityId: SANDBOX_CAPABILITY_ID,
    capabilityVersion: SANDBOX_CAPABILITY_VERSION,
    pieceId: SANDBOX_PIECE_ID,
    pieceVersion: SANDBOX_PIECE_VERSION,
    actionId: SANDBOX_ACTION_ID,
    input: { contactId: `contact-${randomBytes(6).toString("hex")}` },
    credential: options.credential,
    probeMode: options.probeMode ?? "normal",
    ...options.overrides,
  };
  return envelope;
}

function safeFailure(requestId: string, errorCategory: string, retryable = false): SandboxResponse {
  return {
    protocolVersion: SANDBOX_PROTOCOL_VERSION,
    requestId,
    ok: false,
    errorCategory,
    retryable,
  };
}

function parseResponse(requestId: string, result: PodmanResult) {
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    return safeFailure(requestId, "SANDBOX_TIMEOUT", true);
  }
  if (result.error && "code" in result.error && result.error.code === "ENOBUFS") {
    return safeFailure(requestId, "RESPONSE_TOO_LARGE");
  }
  if (result.status === 137 || /cannot allocate memory|out of memory|killed/i.test(result.stderr)) {
    return safeFailure(requestId, "SANDBOX_RESOURCE_LIMIT", true);
  }
  const bytes = Buffer.byteLength(result.stdout, "utf8");
  if (bytes > SANDBOX_MAX_RESPONSE_BYTES) return safeFailure(requestId, "RESPONSE_TOO_LARGE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return safeFailure(requestId, "MALFORMED_SANDBOX_RESPONSE");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return safeFailure(requestId, "MALFORMED_SANDBOX_RESPONSE");
  }
  const response = parsed as SandboxResponse;
  if (response.protocolVersion !== SANDBOX_PROTOCOL_VERSION) {
    return safeFailure(requestId, "MALFORMED_SANDBOX_RESPONSE");
  }
  if (response.requestId !== requestId) return safeFailure(requestId, "MISMATCHED_REQUEST_ID");
  return response;
}

function containerRemoved(name: string) {
  const exists = podman(["container", "exists", name], { timeout: 15_000 });
  return exists.status !== 0;
}

function forceRemoveContainer(name: string) {
  podman(["rm", "--force", "--ignore", name], { timeout: 15_000 });
}

function invokeSignedEnvelope(
  envelope: SandboxEnvelope,
  options: { timeoutMs?: number; parentValidation?: boolean } = {},
): SandboxInvocation {
  ensureSandboxImage();
  const signed = signEnvelope(envelope);
  if (options.parentValidation !== false) {
    const validationError = validateEnvelope(signed);
    if (validationError) throw new Error(`Parent rejected request: ${validationError}`);
  }
  const serialized = JSON.stringify(signed);
  if (Buffer.byteLength(serialized, "utf8") > SANDBOX_MAX_REQUEST_BYTES) {
    throw new Error("Parent rejected request: REQUEST_TOO_LARGE");
  }

  const containerName = `e50-${envelope.requestId}`;
  const started = performance.now();
  const result = podman(
    [
      "run",
      "--rm",
      "--interactive",
      "--name",
      containerName,
      "--label",
      RUNTIME_LABEL,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=4m",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=16",
      "--memory=134217728",
      "--memory-swap=134217728",
      "--cpus=0.5",
      "--ulimit=nofile=64:64",
      "--user=65532:65532",
      "--env=NODE_ENV=production",
      "--env=HOME=/home/sandbox",
      "--log-driver=none",
      "--stop-timeout=1",
      imageTag,
    ],
    {
      input: serialized,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: SANDBOX_MAX_RESPONSE_BYTES + 1,
    },
  );
  const processFinished = performance.now();
  forceRemoveContainer(containerName);
  const removed = containerRemoved(containerName);
  const finished = performance.now();
  return {
    requestId: envelope.requestId,
    response: parseResponse(envelope.requestId, result),
    totalMs: Number((finished - started).toFixed(2)),
    cleanupMs: Number((finished - processFinished).toFixed(2)),
    processStatus: result.status,
    containerRemoved: removed,
    stdout: result.stdout,
    stderr: result.stderr,
    containerName,
  };
}

export function invokeSandbox(options: { credential: string; probeMode?: ProbeMode; timeoutMs?: number }) {
  return invokeSignedEnvelope(defaultEnvelope(options), { timeoutMs: options.timeoutMs });
}

export function invokeSandboxWithOverridesForTest(options: {
  credential: string;
  overrides: Partial<SandboxEnvelope>;
  timeoutMs?: number;
}) {
  return invokeSignedEnvelope(defaultEnvelope(options), {
    parentValidation: false,
    timeoutMs: options.timeoutMs,
  });
}

export function invokeRawSandboxForTest(raw: string, requestId = randomUUID()) {
  ensureSandboxImage();
  const containerName = `e50-${requestId}`;
  const started = performance.now();
  const result = podman(
    [
      "run",
      "--rm",
      "--interactive",
      "--name",
      containerName,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=4m",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=16",
      "--memory=134217728",
      "--memory-swap=134217728",
      "--cpus=0.5",
      "--user=65532:65532",
      "--log-driver=none",
      imageTag,
    ],
    { input: raw, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: SANDBOX_MAX_RESPONSE_BYTES + 1 },
  );
  forceRemoveContainer(containerName);
  const finished = performance.now();
  return {
    requestId,
    response: parseResponse(requestId, result),
    totalMs: Number((finished - started).toFixed(2)),
    cleanupMs: 0,
    processStatus: result.status,
    containerRemoved: containerRemoved(containerName),
    stdout: result.stdout,
    stderr: result.stderr,
    containerName,
  } satisfies SandboxInvocation;
}

export function imageEvidence() {
  ensureSandboxImage();
  const inspect = podman([
    "image",
    "inspect",
    imageTag,
    "--format",
    "{{.Size}}|{{.Digest}}|{{.Config.User}}|{{json .Config.Env}}",
  ]);
  if (inspect.status !== 0) throw new Error("Could not inspect the sandbox image.");
  const [size, digest, user, environment] = inspect.stdout.trim().split("|");
  return { sizeBytes: Number(size), digest, user, environment };
}

export function countRunningSandboxContainers() {
  const result = podman([
    "ps",
    "--filter",
    `label=${RUNTIME_LABEL}`,
    "--format",
    "{{.ID}}",
  ]);
  if (result.status !== 0) return -1;
  return result.stdout.trim() ? result.stdout.trim().split(/\r?\n/).length : 0;
}

export function canaryPersistenceOccurrences(tokens: string[], invocations: SandboxInvocation[]) {
  ensureSandboxImage();
  const history = podman(["history", "--no-trunc", imageTag]);
  const inspect = podman(["image", "inspect", imageTag]);
  const gitDiff = spawnSync("git", ["diff"], {
    cwd: dirname(dirname(EXPERIMENT_DIRECTORY)),
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  });
  const surfaces = [
    ...invocations.flatMap((invocation) => [invocation.stdout, invocation.stderr]),
    history.stdout,
    history.stderr,
    inspect.stdout,
    inspect.stderr,
    gitDiff.stdout,
    gitDiff.stderr,
  ];
  return tokens.reduce(
    (total, token) =>
      total + surfaces.reduce((count, surface) => count + (surface.includes(token) ? 1 : 0), 0),
    0,
  );
}

export function freshParentSentinels() {
  return Object.fromEntries(
    PARENT_SENTINEL_NAMES.map((name) => [name, `E50_${randomBytes(24).toString("hex")}`]),
  );
}

export const sandboxConstants = {
  imageTag,
  imageRepository: IMAGE_REPOSITORY,
  protocolVersion: SANDBOX_PROTOCOL_VERSION,
  capabilityId: SANDBOX_CAPABILITY_ID,
  capabilityVersion: SANDBOX_CAPABILITY_VERSION,
  pieceId: SANDBOX_PIECE_ID,
  pieceVersion: SANDBOX_PIECE_VERSION,
  actionId: SANDBOX_ACTION_ID,
  maxRequestBytes: SANDBOX_MAX_REQUEST_BYTES,
  maxResponseBytes: SANDBOX_MAX_RESPONSE_BYTES,
};
