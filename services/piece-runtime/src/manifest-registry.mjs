import { isIP } from "node:net";

import { REVIEWED_PIECE_BUILDS } from "./build-registry.mjs";
import { deepFreeze } from "./deep-freeze.mjs";
import { PieceRuntimeError } from "./errors.mjs";

export const HUBSPOT_GET_CONTACT_MANIFEST = deepFreeze({
  capabilityId: "hubspot.get_contact",
  capabilityVersion: 1,
  buildId: "activepieces-hubspot-0_8_10",
  providerId: "hubspot",
  piecePackage: "@activepieces/piece-hubspot",
  pieceVersion: "0.8.10",
  npmIntegrity: "sha512-P3svTd/XaaPhYfsOSz6YpgdfNcARRawqAddBGtJUxW/Grbc5InTdsvddlgSdyQtJxH+3UpxrKAR1VjlGJ4hfNA==",
  upstreamSourceCommit: "e7e44d4ef9a2a2bcec8cb611eb63af5df2ba019e",
  sourcePath: "packages/pieces/community/hubspot",
  license: "MIT Expat",
  actionId: "get-contact",
  expectedClassification: "READ",
  operationClassification: "READ",
  authProjection: "oauth2_access_token",
  destinations: [{ hostname: "api.hubapi.com", port: 443, protocol: "tls" }],
  maximumRequestBytes: 32 * 1024,
  maximumResponseBytes: 128 * 1024,
  maximumProviderUpstreamBytes: 128 * 1024,
  maximumProviderDownstreamBytes: 128 * 1024,
  inputMapper: "hubspot_get_contact_v1",
  outputNormalizer: "hubspot_contact_v1",
  modes: ["TEST"],
  resourceLimits: {
    executionTimeoutMs: 5_000,
    handshakeTimeoutMs: 1_500,
    connectTimeoutMs: 1_500,
    idleTimeoutMs: 2_000,
    lifetimeTimeoutMs: 7_000,
    simultaneousConnections: 2,
    sandbox: {
      uid: 65532,
      gid: 65532,
      readOnlyRoot: true,
      tmpfsBytes: 4 * 1024 * 1024,
      tmpfsOptions: ["noexec", "nosuid", "nodev"],
      capDrop: ["ALL"],
      noNewPrivileges: true,
      pids: 16,
      memoryBytes: 128 * 1024 * 1024,
      memorySwapBytes: 128 * 1024 * 1024,
      cpus: 0.5,
      fileDescriptors: 64,
      hostMounts: 0,
      dockerSocket: false,
    },
    gateway: {
      uid: 65532,
      gid: 65532,
      readOnlyRoot: true,
      capDrop: ["ALL"],
      noNewPrivileges: true,
      pids: 16,
      memoryBytes: 64 * 1024 * 1024,
      memorySwapBytes: 64 * 1024 * 1024,
      cpus: 0.25,
      fileDescriptors: 64,
      credentialAccess: false,
      dockerSocket: false,
    },
  },
  retryPolicy: {
    runtimeAttempts: 1,
    safeAutomaticRetry: false,
    ambiguity: "A timeout or network failure may have an unknown provider outcome.",
  },
});

function key(capabilityId, capabilityVersion) {
  return `${capabilityId}@${capabilityVersion}`;
}

const MANIFEST_KEYS = Object.freeze([
  "capabilityId", "capabilityVersion", "buildId", "providerId", "piecePackage", "pieceVersion",
  "npmIntegrity", "upstreamSourceCommit", "sourcePath", "license", "actionId",
  "expectedClassification", "operationClassification", "authProjection", "destinations",
  "maximumRequestBytes", "maximumResponseBytes", "maximumProviderUpstreamBytes",
  "maximumProviderDownstreamBytes", "inputMapper", "outputNormalizer", "modes",
  "resourceLimits", "retryPolicy",
]);

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((entry, index) => entry === allowed[index]);
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !exactKeys(manifest, MANIFEST_KEYS)) {
    throw new Error("Reviewed piece manifest is invalid.");
  }
  if (
    !/^[a-z][a-z0-9_]{1,79}\.[a-z][a-z0-9_]{1,79}$/.test(manifest.capabilityId) ||
    !boundedInteger(manifest.capabilityVersion, 1, 1_000) ||
    !/^[a-z][a-z0-9_-]{2,100}$/.test(manifest.buildId) ||
    !/^[a-z][a-z0-9_-]{1,79}$/.test(manifest.providerId) ||
    !/^@[a-z0-9_-]+\/[a-z0-9_-]+$/.test(manifest.piecePackage) ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(manifest.pieceVersion) ||
    typeof manifest.npmIntegrity !== "string" || !manifest.npmIntegrity.startsWith("sha512-") ||
    !/^[a-f0-9]{40}$/.test(manifest.upstreamSourceCommit) ||
    typeof manifest.sourcePath !== "string" || manifest.sourcePath.length < 1 || manifest.sourcePath.length > 240 ||
    typeof manifest.license !== "string" || manifest.license.length < 1 || manifest.license.length > 80 ||
    !/^[a-z][a-z0-9-]{1,79}$/.test(manifest.actionId) ||
    !new Set(["READ", "WRITE"]).has(manifest.expectedClassification) ||
    manifest.operationClassification !== manifest.expectedClassification ||
    !new Set(["oauth2_access_token", "secret_text"]).has(manifest.authProjection) ||
    !/^[a-z][a-z0-9_]{2,79}$/.test(manifest.inputMapper) ||
    !/^[a-z][a-z0-9_]{2,79}$/.test(manifest.outputNormalizer)
  ) {
    throw new Error("Reviewed piece manifest is invalid.");
  }
  for (const bytes of [manifest.maximumRequestBytes, manifest.maximumResponseBytes, manifest.maximumProviderUpstreamBytes, manifest.maximumProviderDownstreamBytes]) {
    if (!boundedInteger(bytes, 1, 1024 * 1024)) throw new Error("Reviewed piece manifest is invalid.");
  }
  if (
    !Array.isArray(manifest.destinations) || manifest.destinations.length < 1 || manifest.destinations.length > 8 ||
    manifest.destinations.some((destination) =>
      !destination || typeof destination !== "object" || Array.isArray(destination) ||
      !exactKeys(destination, ["hostname", "port", "protocol"]) ||
      typeof destination.hostname !== "string" || destination.hostname.length < 1 ||
      destination.hostname.length > 253 || destination.hostname.includes("*") ||
      isIP(destination.hostname) !== 0 || destination.port !== 443 || destination.protocol !== "tls") ||
    !Array.isArray(manifest.modes) || manifest.modes.length < 1 ||
    manifest.modes.some((mode) => !new Set(["TEST", "LIVE"]).has(mode))
  ) {
    throw new Error("Reviewed piece manifest is invalid.");
  }
  const sandbox = manifest.resourceLimits?.sandbox;
  const gateway = manifest.resourceLimits?.gateway;
  if (
    !boundedInteger(manifest.resourceLimits?.executionTimeoutMs, 10, 30_000) ||
    !boundedInteger(manifest.resourceLimits?.handshakeTimeoutMs, 10, 10_000) ||
    !boundedInteger(manifest.resourceLimits?.connectTimeoutMs, 10, 10_000) ||
    !boundedInteger(manifest.resourceLimits?.idleTimeoutMs, 10, 30_000) ||
    !boundedInteger(manifest.resourceLimits?.lifetimeTimeoutMs, 10, 60_000) ||
    !boundedInteger(manifest.resourceLimits?.simultaneousConnections, 1, 8) ||
    sandbox?.uid !== 65532 || sandbox?.gid !== 65532 || sandbox?.readOnlyRoot !== true ||
    sandbox?.tmpfsBytes !== 4 * 1024 * 1024 || sandbox?.noNewPrivileges !== true ||
    sandbox?.pids !== 16 || sandbox?.memoryBytes !== 128 * 1024 * 1024 ||
    sandbox?.memorySwapBytes !== sandbox.memoryBytes || sandbox?.cpus !== 0.5 ||
    sandbox?.fileDescriptors !== 64 || sandbox?.hostMounts !== 0 || sandbox?.dockerSocket !== false ||
    gateway?.uid !== 65532 || gateway?.gid !== 65532 || gateway?.readOnlyRoot !== true ||
    gateway?.noNewPrivileges !== true || gateway?.pids !== 16 ||
    gateway?.memoryBytes !== 64 * 1024 * 1024 || gateway?.memorySwapBytes !== gateway.memoryBytes ||
    gateway?.cpus !== 0.25 || gateway?.fileDescriptors !== 64 ||
    gateway?.credentialAccess !== false || gateway?.dockerSocket !== false ||
    manifest.retryPolicy?.runtimeAttempts !== 1 || manifest.retryPolicy?.safeAutomaticRetry !== false
  ) {
    throw new Error("Reviewed piece manifest is invalid.");
  }
}

export function createManifestRegistry(manifests, builds = REVIEWED_PIECE_BUILDS) {
  const entries = new Map();
  for (const source of manifests) {
    validateManifest(source);
    builds.getForManifest(source);
    const manifest = deepFreeze(structuredClone(source));
    const manifestKey = key(manifest.capabilityId, manifest.capabilityVersion);
    if (entries.has(manifestKey)) throw new Error("Duplicate reviewed piece manifest.");
    entries.set(manifestKey, manifest);
  }
  return Object.freeze({
    get(capabilityId, capabilityVersion) {
      const manifest = entries.get(key(capabilityId, capabilityVersion));
      if (!manifest) throw new PieceRuntimeError("PIECE_UNSUPPORTED_CAPABILITY");
      return manifest;
    },
    list() {
      return Object.freeze([...entries.values()]);
    },
  });
}

export const REVIEWED_MANIFESTS = createManifestRegistry([HUBSPOT_GET_CONTACT_MANIFEST]);
