import "@/lib/server-only-runtime";

import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";

import type {
  DelegatedErrorCategory,
  DelegatedExecutionMode,
} from "@/lib/executors/types";

export const CONNECTOR_RUNNER_PROTOCOL_VERSION = 1 as const;
export const CONNECTOR_RUNNER_CAPSULE_ALGORITHM = "aes-256-gcm" as const;
export const CONNECTOR_RUNNER_DEFAULT_CAPSULE_TTL_MS = 30_000;
export const CONNECTOR_RUNNER_MAX_CAPSULE_TTL_MS = 120_000;
export const CONNECTOR_RUNNER_MAX_REQUEST_BYTES = 128 * 1024;
export const CONNECTOR_RUNNER_MAX_RESPONSE_BYTES = 64 * 1024;

const WRAP_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const MAX_CREDENTIAL_BYTES = 16 * 1024;

export type ConnectorRunnerCapsuleBinding = {
  protocolVersion: typeof CONNECTOR_RUNNER_PROTOCOL_VERSION;
  requestId: string;
  executionId: string;
  workflowVersionId: string;
  stepId: string;
  capabilityId: string;
  capabilityVersion: number;
};

export type ConnectorRunnerCredentialCapsule = {
  keyVersion: number;
  algorithm: typeof CONNECTOR_RUNNER_CAPSULE_ALGORITHM;
  nonce: string;
  ciphertext: string;
  authTag: string;
  expiresAt: number;
};

export type ConnectorRunnerRequestEnvelope = ConnectorRunnerCapsuleBinding & {
  mode: DelegatedExecutionMode;
  idempotencyKey: string;
  input: Record<string, unknown>;
  credentialCapsule: ConnectorRunnerCredentialCapsule;
};

export type ConnectorRunnerResponse =
  | {
      protocolVersion: typeof CONNECTOR_RUNNER_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      acknowledged: true;
      output: Record<string, unknown>;
    }
  | {
      protocolVersion: typeof CONNECTOR_RUNNER_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      errorCategory: DelegatedErrorCategory;
      retryable: boolean;
    };

export class ConnectorRunnerProtocolError extends Error {
  constructor() {
    super("Connector runner request could not be prepared.");
    this.name = "ConnectorRunnerProtocolError";
  }
}

function reject(): never {
  throw new ConnectorRunnerProtocolError();
}

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 160;
}

function validateBinding(binding: ConnectorRunnerCapsuleBinding): void {
  if (
    binding.protocolVersion !== CONNECTOR_RUNNER_PROTOCOL_VERSION ||
    !boundedIdentity(binding.requestId) ||
    !boundedIdentity(binding.executionId) ||
    !boundedIdentity(binding.workflowVersionId) ||
    !boundedIdentity(binding.stepId) ||
    !boundedIdentity(binding.capabilityId) ||
    !Number.isSafeInteger(binding.capabilityVersion) ||
    binding.capabilityVersion < 1
  ) reject();
}

function parseVersion(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,5}$/.test(value)) reject();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) reject();
  return parsed;
}

function parseWrapKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) reject();
  const key = Buffer.from(value, "base64");
  if (key.length !== WRAP_KEY_BYTES || key.toString("base64") !== value) {
    key.fill(0);
    reject();
  }
  return key;
}

export function loadConnectorRunnerActiveWrapKeyFromEnvironment(): {
  keyVersion: number;
  key: Buffer;
} {
  const keyVersion = parseVersion(process.env.CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION);
  const key = parseWrapKey(process.env[`CONNECTOR_RUNNER_WRAP_KEY_V${keyVersion}`]);
  return { keyVersion, key };
}

export function createConnectorRunnerCapsuleAdditionalData(input: {
  binding: ConnectorRunnerCapsuleBinding;
  keyVersion: number;
  expiresAt: number;
}): Buffer {
  validateBinding(input.binding);
  if (
    !Number.isSafeInteger(input.keyVersion) ||
    input.keyVersion < 1 ||
    !Number.isSafeInteger(input.expiresAt)
  ) reject();
  return Buffer.from(JSON.stringify({
    namespace: "crazyloops:connector-runner:credential-capsule:v1",
    protocolVersion: input.binding.protocolVersion,
    requestId: input.binding.requestId,
    executionId: input.binding.executionId,
    workflowVersionId: input.binding.workflowVersionId,
    stepId: input.binding.stepId,
    capabilityId: input.binding.capabilityId,
    capabilityVersion: input.binding.capabilityVersion,
    keyVersion: input.keyVersion,
    algorithm: CONNECTOR_RUNNER_CAPSULE_ALGORITHM,
    expiresAt: input.expiresAt,
  }), "utf8");
}

export function createConnectorRunnerCredentialCapsule(input: {
  credential: Buffer;
  binding: ConnectorRunnerCapsuleBinding;
  keyVersion: number;
  wrapKey: Buffer;
  now?: number;
  ttlMs?: number;
  randomBytesImplementation?: (size: number) => Buffer;
}): ConnectorRunnerCredentialCapsule {
  validateBinding(input.binding);
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? CONNECTOR_RUNNER_DEFAULT_CAPSULE_TTL_MS;
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > CONNECTOR_RUNNER_MAX_CAPSULE_TTL_MS ||
    input.credential.length < 1 ||
    input.credential.length > MAX_CREDENTIAL_BYTES ||
    input.wrapKey.length !== WRAP_KEY_BYTES
  ) reject();
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) reject();
  const nonce = (input.randomBytesImplementation ?? randomBytes)(NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) reject();
  const key = Buffer.from(input.wrapKey);
  try {
    const cipher = createCipheriv(CONNECTOR_RUNNER_CAPSULE_ALGORITHM, key, nonce);
    cipher.setAAD(createConnectorRunnerCapsuleAdditionalData({
      binding: input.binding,
      keyVersion: input.keyVersion,
      expiresAt,
    }));
    const ciphertext = Buffer.concat([
      cipher.update(input.credential),
      cipher.final(),
    ]);
    return {
      keyVersion: input.keyVersion,
      algorithm: CONNECTOR_RUNNER_CAPSULE_ALGORITHM,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      expiresAt,
    };
  } catch {
    reject();
  } finally {
    key.fill(0);
  }
}

export function createConnectorRunnerBodyDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createConnectorRunnerSignature(input: {
  secret: string;
  timestamp: string;
  requestId: string;
  bodyDigest: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.requestId}.${input.bodyDigest}`)
    .digest("hex");
}
