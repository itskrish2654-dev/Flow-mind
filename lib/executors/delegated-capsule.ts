import "@/lib/server-only-runtime";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";

export const DELEGATED_CAPSULE_PROTOCOL_VERSION = 2 as const;
export const DELEGATED_CAPSULE_ALGORITHM = "aes-256-gcm" as const;
export const DELEGATED_CAPSULE_DEFAULT_TTL_MS = 30_000;
export const DELEGATED_CAPSULE_MAX_TTL_MS = 120_000;

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const WRAP_KEY_BYTES = 32;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_CREDENTIAL_BYTES + 32;
const MAX_KEY_VERSIONS = 8;

export const DELEGATED_CAPSULE_ERROR_CATEGORIES = [
  "DELEGATED_CAPSULE_CONFIGURATION_INVALID",
  "DELEGATED_CAPSULE_REJECTED",
  "DELEGATED_CAPSULE_EXPIRED",
  "DELEGATED_CAPSULE_REPLAYED",
] as const;

export type DelegatedCapsuleErrorCategory =
  (typeof DELEGATED_CAPSULE_ERROR_CATEGORIES)[number];

export class DelegatedCapsuleError extends Error {
  readonly category: DelegatedCapsuleErrorCategory;

  constructor(category: DelegatedCapsuleErrorCategory) {
    super(
      category === "DELEGATED_CAPSULE_CONFIGURATION_INVALID"
        ? "Delegated credential wrapping is not configured."
        : "Delegated credential capsule was rejected.",
    );
    this.name = "DelegatedCapsuleError";
    this.category = category;
  }
}

export type DelegatedCapsuleBinding = {
  protocolVersion: typeof DELEGATED_CAPSULE_PROTOCOL_VERSION;
  requestId: string;
  executionId: string;
  workflowVersionId: string;
  stepId: string;
  capabilityId: string;
  capabilityVersion: number;
};

export type DelegatedCredentialCapsule = {
  keyVersion: number;
  algorithm: typeof DELEGATED_CAPSULE_ALGORITHM;
  nonce: string;
  ciphertext: string;
  authTag: string;
  expiresAt: number;
};

export type DelegatedWrapKeyRing = {
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
};

export type DelegatedCapsuleClaim = (input: {
  fingerprint: string;
  expiresAt: number;
}) => Promise<boolean>;

export type CanarySimulation =
  | "success"
  | "adapter_throw"
  | "provider_401"
  | "provider_429"
  | "provider_500"
  | "timeout";

export type CanaryAdapterResult =
  | { ok: true; proof: string }
  | {
      ok: false;
      errorCategory:
        | DelegatedCapsuleErrorCategory
        | "DELEGATED_AUTH_FAILED"
        | "DELEGATED_RATE_LIMITED"
        | "DELEGATED_UNAVAILABLE"
        | "DELEGATED_TIMEOUT"
        | "DELEGATED_EXECUTION_FAILED";
      retryable: boolean;
    };

function configurationError(): never {
  throw new DelegatedCapsuleError("DELEGATED_CAPSULE_CONFIGURATION_INVALID");
}

function rejection(category: DelegatedCapsuleErrorCategory = "DELEGATED_CAPSULE_REJECTED"): never {
  throw new DelegatedCapsuleError(category);
}

function decodeCanonicalBase64(value: unknown, exactBytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    rejection();
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64") !== value ||
    (exactBytes !== undefined && decoded.length !== exactBytes)
  ) {
    rejection();
  }
  return decoded;
}

function parseVersion(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,5}$/.test(value)) configurationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) configurationError();
  return parsed;
}

function parseCanonicalWrapKey(value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    configurationError();
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== WRAP_KEY_BYTES || key.toString("base64") !== value) {
    configurationError();
  }
  return key;
}

export function parseDelegatedWrapKeyRing(input: {
  serializedKeys: string | undefined;
  activeVersion: string | undefined;
}): DelegatedWrapKeyRing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.serializedKeys ?? "");
  } catch {
    configurationError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) configurationError();

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_KEY_VERSIONS) configurationError();
  const keys = new Map<number, Buffer>();
  for (const [rawVersion, rawKey] of entries) {
    const version = parseVersion(rawVersion);
    if (keys.has(version)) configurationError();
    keys.set(version, parseCanonicalWrapKey(rawKey));
  }

  const activeVersion = parseVersion(input.activeVersion);
  if (!keys.has(activeVersion)) configurationError();
  return { activeVersion, keys };
}

export function loadDelegatedWrapKeyRingFromEnvironment(): DelegatedWrapKeyRing {
  return parseDelegatedWrapKeyRing({
    serializedKeys: process.env.CRAZYLOOPS_DELEGATED_WRAP_KEYS,
    activeVersion: process.env.CRAZYLOOPS_DELEGATED_WRAP_ACTIVE_VERSION,
  });
}

function validateBoundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

function validateBinding(binding: DelegatedCapsuleBinding): void {
  if (
    binding.protocolVersion !== DELEGATED_CAPSULE_PROTOCOL_VERSION ||
    !validateBoundedIdentity(binding.requestId) ||
    !validateBoundedIdentity(binding.executionId) ||
    !validateBoundedIdentity(binding.workflowVersionId) ||
    !validateBoundedIdentity(binding.stepId) ||
    !validateBoundedIdentity(binding.capabilityId) ||
    !Number.isSafeInteger(binding.capabilityVersion) ||
    binding.capabilityVersion < 1
  ) {
    rejection();
  }
}

function additionalData(input: {
  binding: DelegatedCapsuleBinding;
  keyVersion: number;
  expiresAt: number;
}): Buffer {
  validateBinding(input.binding);
  return Buffer.from(JSON.stringify({
    namespace: "crazyloops:delegated-credential-capsule",
    protocolVersion: input.binding.protocolVersion,
    requestId: input.binding.requestId,
    executionId: input.binding.executionId,
    workflowVersionId: input.binding.workflowVersionId,
    stepId: input.binding.stepId,
    capabilityId: input.binding.capabilityId,
    capabilityVersion: input.binding.capabilityVersion,
    keyVersion: input.keyVersion,
    algorithm: DELEGATED_CAPSULE_ALGORITHM,
    expiresAt: input.expiresAt,
  }), "utf8");
}

function getKey(keyRing: DelegatedWrapKeyRing, version: number): Buffer {
  const key = keyRing.keys.get(version);
  if (!key || key.length !== WRAP_KEY_BYTES) rejection();
  return Buffer.from(key);
}

export function createDelegatedCredentialCapsule(input: {
  credential: string;
  binding: DelegatedCapsuleBinding;
  keyRing: DelegatedWrapKeyRing;
  now?: number;
  ttlMs?: number;
  randomBytesImplementation?: (size: number) => Buffer;
}): DelegatedCredentialCapsule {
  validateBinding(input.binding);
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DELEGATED_CAPSULE_DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DELEGATED_CAPSULE_MAX_TTL_MS) {
    rejection();
  }
  const plaintext = Buffer.from(input.credential, "utf8");
  if (plaintext.length === 0 || plaintext.length > MAX_CREDENTIAL_BYTES) {
    plaintext.fill(0);
    rejection();
  }

  const keyVersion = input.keyRing.activeVersion;
  const key = getKey(input.keyRing, keyVersion);
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    plaintext.fill(0);
    key.fill(0);
    rejection();
  }
  const nonce = (input.randomBytesImplementation ?? randomBytes)(NONCE_BYTES);
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
    plaintext.fill(0);
    key.fill(0);
    rejection();
  }

  try {
    const cipher = createCipheriv(DELEGATED_CAPSULE_ALGORITHM, key, nonce);
    cipher.setAAD(additionalData({ binding: input.binding, keyVersion, expiresAt }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      keyVersion,
      algorithm: DELEGATED_CAPSULE_ALGORITHM,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      expiresAt,
    };
  } catch {
    rejection();
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

function openCredentialBuffer(input: {
  capsule: DelegatedCredentialCapsule;
  binding: DelegatedCapsuleBinding;
  keyRing: DelegatedWrapKeyRing;
  now: number;
}): Buffer {
  const { capsule } = input;
  validateBinding(input.binding);
  if (
    capsule.algorithm !== DELEGATED_CAPSULE_ALGORITHM ||
    !Number.isSafeInteger(capsule.keyVersion) ||
    capsule.keyVersion < 1 ||
    !Number.isSafeInteger(capsule.expiresAt)
  ) {
    rejection();
  }
  if (capsule.expiresAt <= input.now) rejection("DELEGATED_CAPSULE_EXPIRED");
  if (capsule.expiresAt - input.now > DELEGATED_CAPSULE_MAX_TTL_MS) rejection();

  const nonce = decodeCanonicalBase64(capsule.nonce, NONCE_BYTES);
  const authTag = decodeCanonicalBase64(capsule.authTag, AUTH_TAG_BYTES);
  const ciphertext = decodeCanonicalBase64(capsule.ciphertext);
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) rejection();
  const key = getKey(input.keyRing, capsule.keyVersion);

  try {
    const decipher = createDecipheriv(DELEGATED_CAPSULE_ALGORITHM, key, nonce);
    decipher.setAAD(additionalData({
      binding: input.binding,
      keyVersion: capsule.keyVersion,
      expiresAt: capsule.expiresAt,
    }));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length === 0 || plaintext.length > MAX_CREDENTIAL_BYTES) {
      plaintext.fill(0);
      rejection();
    }
    return plaintext;
  } catch (error) {
    if (error instanceof DelegatedCapsuleError) throw error;
    rejection();
  } finally {
    key.fill(0);
  }
}

function capsuleFingerprint(input: {
  capsule: DelegatedCredentialCapsule;
  binding: DelegatedCapsuleBinding;
}): string {
  return createHash("sha256").update(JSON.stringify({
    binding: input.binding,
    capsule: input.capsule,
  })).digest("hex");
}

export async function consumeDelegatedCredential<T>(input: {
  capsule: DelegatedCredentialCapsule;
  binding: DelegatedCapsuleBinding;
  keyRing: DelegatedWrapKeyRing;
  claim: DelegatedCapsuleClaim;
  use: (credential: Buffer) => Promise<T> | T;
  now?: number;
}): Promise<T> {
  const plaintext = openCredentialBuffer({
    capsule: input.capsule,
    binding: input.binding,
    keyRing: input.keyRing,
    now: input.now ?? Date.now(),
  });
  try {
    const claimed = await input.claim({
      fingerprint: capsuleFingerprint(input),
      expiresAt: input.capsule.expiresAt,
    });
    if (!claimed) rejection("DELEGATED_CAPSULE_REPLAYED");
    return await input.use(plaintext);
  } finally {
    plaintext.fill(0);
  }
}

function capsuleFailure(error: unknown): CanaryAdapterResult {
  if (error instanceof DelegatedCapsuleError) {
    return { ok: false, errorCategory: error.category, retryable: false };
  }
  return { ok: false, errorCategory: "DELEGATED_EXECUTION_FAILED", retryable: false };
}

export async function runCredentialCanaryAdapter(input: {
  capsule: DelegatedCredentialCapsule;
  binding: DelegatedCapsuleBinding;
  keyRing: DelegatedWrapKeyRing;
  claim: DelegatedCapsuleClaim;
  simulation?: CanarySimulation;
  now?: number;
}): Promise<CanaryAdapterResult> {
  try {
    return await consumeDelegatedCredential({
      ...input,
      use: async (credential) => {
        switch (input.simulation ?? "success") {
          case "adapter_throw":
            throw new Error("Simulated adapter failure.");
          case "provider_401":
            return { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false };
          case "provider_429":
            return { ok: false, errorCategory: "DELEGATED_RATE_LIMITED", retryable: true };
          case "provider_500":
            return { ok: false, errorCategory: "DELEGATED_UNAVAILABLE", retryable: true };
          case "timeout":
            return { ok: false, errorCategory: "DELEGATED_TIMEOUT", retryable: true };
          case "success":
            return {
              ok: true,
              proof: createHmac("sha256", credential)
                .update(`crazyloops-canary-proof:${input.binding.requestId}`)
                .digest("hex"),
            };
        }
      },
    });
  } catch (error) {
    return capsuleFailure(error);
  }
}
