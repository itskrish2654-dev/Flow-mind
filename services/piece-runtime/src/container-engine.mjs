import { createHash } from "node:crypto";

import { REVIEWED_PIECE_BUILDS } from "./build-registry.mjs";
import { deepFreeze } from "./deep-freeze.mjs";
import { PieceRuntimeError } from "./errors.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";
import { validateInvocationRequest } from "./protocol.mjs";

export const PIECE_RUNTIME_IMAGES = deepFreeze({
  gateway: "crazyloops/piece-runtime-gateway:step5a",
});

function suffix(requestId) {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 16);
}

export function validateResourceName(value) {
  return typeof value === "string" && /^cl-piece-[a-z]+-[a-f0-9]{16}$/.test(value);
}

export function buildInvocationPlan(requestValue, manifests = REVIEWED_MANIFESTS, builds = REVIEWED_PIECE_BUILDS) {
  const request = validateInvocationRequest(requestValue);
  const manifest = manifests.get(request.capabilityId, request.capabilityVersion);
  const build = builds.getForManifest(manifest);
  const id = suffix(request.requestId);
  const names = {
    sandbox: `cl-piece-sandbox-${id}`,
    gateway: `cl-piece-gateway-${id}`,
    internalNetwork: `cl-piece-internal-${id}`,
    egressNetwork: `cl-piece-egress-${id}`,
  };
  if (!Object.values(names).every(validateResourceName)) {
    throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }
  return deepFreeze({
    invocationId: id,
    names,
    labels: { "crazyloops.runtime": "piece-runtime-step5a", "crazyloops.invocation": id },
    manifestKey: `${manifest.capabilityId}@${manifest.capabilityVersion}`,
    buildId: build.buildId,
    images: {
      sandbox: build.sandboxImage,
      gateway: PIECE_RUNTIME_IMAGES.gateway,
    },
    sandbox: {
      network: names.internalNetwork,
      internalOnlyNetwork: true,
      canonicalHostMappings: manifest.destinations.map((destination) => ({
        hostname: destination.hostname,
        target: "gateway_internal_ip",
        gatewayName: names.gateway,
      })),
      readOnlyRoot: true,
      tmpfs: "/tmp:rw,noexec,nosuid,nodev,size=4m",
      capDrop: ["ALL"],
      noNewPrivileges: true,
      pidsLimit: 16,
      memoryBytes: 128 * 1024 * 1024,
      memorySwapBytes: 128 * 1024 * 1024,
      cpus: 0.5,
      nofile: "64:64",
      user: "65532:65532",
      mounts: [],
      dockerSocket: false,
      logDriver: "none",
      stdinOnlyCredential: true,
    },
    gateway: {
      networks: [names.internalNetwork, names.egressNetwork],
      internalAliases: [names.gateway],
      providerHostAliases: [],
      resolverHostnames: manifest.destinations.map((destination) => destination.hostname),
      publishedPorts: [],
      readOnlyRoot: true,
      capDrop: ["ALL"],
      noNewPrivileges: true,
      pidsLimit: 16,
      memoryBytes: 64 * 1024 * 1024,
      memorySwapBytes: 64 * 1024 * 1024,
      cpus: 0.25,
      nofile: "64:64",
      user: "65532:65532",
      mounts: [],
      dockerSocket: false,
      credentialAccess: false,
      environment: {
        PIECE_RUNTIME_CAPABILITY_ID: manifest.capabilityId,
        PIECE_RUNTIME_CAPABILITY_VERSION: String(manifest.capabilityVersion),
        PIECE_RUNTIME_REQUEST_ID: request.requestId,
      },
    },
  });
}

export class PieceContainerEngine {
  /** @returns {Promise<unknown>} */
  async runInvocation(_input) {
    void _input;
    throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }

  async cleanupInvocation(_plan) {
    void _plan;
    throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }
}

export async function executeWithContainerEngine({ engine, request, credential, manifests = REVIEWED_MANIFESTS, builds = REVIEWED_PIECE_BUILDS }) {
  if (!(engine instanceof PieceContainerEngine)) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  const plan = buildInvocationPlan(request, manifests, builds);
  try {
    return await engine.runInvocation({ plan, request, credential });
  } finally {
    if (Buffer.isBuffer(credential)) credential.fill(0);
    await engine.cleanupInvocation(plan);
  }
}
