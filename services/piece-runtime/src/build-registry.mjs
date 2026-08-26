import { deepFreeze } from "./deep-freeze.mjs";
import { PieceRuntimeError } from "./errors.mjs";

const BUILD_KEYS = Object.freeze([
  "buildId",
  "packageName",
  "packageVersion",
  "npmIntegrity",
  "upstreamSourceCommit",
  "sandboxImage",
  "actions",
]);

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((entry, index) => entry === allowed[index]);
}

function fail() {
  throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
}

async function resolveHubSpotGetContact() {
  const loaded = await import("@activepieces/piece-hubspot");
  return loaded.hubspot?.actions?.()["get-contact"];
}

export const HUBSPOT_0_8_10_BUILD = {
  buildId: "activepieces-hubspot-0_8_10",
  packageName: "@activepieces/piece-hubspot",
  packageVersion: "0.8.10",
  npmIntegrity: "sha512-P3svTd/XaaPhYfsOSz6YpgdfNcARRawqAddBGtJUxW/Grbc5InTdsvddlgSdyQtJxH+3UpxrKAR1VjlGJ4hfNA==",
  upstreamSourceCommit: "e7e44d4ef9a2a2bcec8cb611eb63af5df2ba019e",
  sandboxImage: "crazyloops/piece-runtime-hubspot:0.8.10-step5a",
  actions: {
    "get-contact": {
      classification: "READ",
      resolve: resolveHubSpotGetContact,
    },
  },
};

function validateBuild(source) {
  if (!source || typeof source !== "object" || Array.isArray(source) || !exactKeys(source, BUILD_KEYS)) fail();
  if (
    !/^[a-z][a-z0-9_-]{2,100}$/.test(source.buildId) ||
    !/^@[a-z0-9_-]+\/[a-z0-9_-]+$/.test(source.packageName) ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(source.packageVersion) ||
    typeof source.npmIntegrity !== "string" || !source.npmIntegrity.startsWith("sha512-") ||
    !/^[a-f0-9]{40}$/.test(source.upstreamSourceCommit) ||
    !/^[a-z0-9][a-z0-9._/-]{2,200}:[A-Za-z0-9._-]{1,100}$/.test(source.sandboxImage) ||
    !source.actions || typeof source.actions !== "object" || Array.isArray(source.actions)
  ) fail();
  const actions = Object.entries(source.actions);
  if (actions.length < 1 || actions.length > 32) fail();
  for (const [actionId, action] of actions) {
    if (
      !/^[a-z][a-z0-9-]{1,79}$/.test(actionId) ||
      !action || typeof action !== "object" || Array.isArray(action) ||
      !exactKeys(action, ["classification", "resolve"]) ||
      !new Set(["READ", "WRITE"]).has(action.classification) ||
      typeof action.resolve !== "function"
    ) fail();
  }
}

function freezeBuild(source) {
  return deepFreeze({
    buildId: source.buildId,
    packageName: source.packageName,
    packageVersion: source.packageVersion,
    npmIntegrity: source.npmIntegrity,
    upstreamSourceCommit: source.upstreamSourceCommit,
    sandboxImage: source.sandboxImage,
    actions: Object.fromEntries(Object.entries(source.actions).map(([actionId, action]) => [
      actionId,
      { classification: action.classification, resolve: action.resolve },
    ])),
  });
}

export function createPieceBuildRegistry(builds) {
  const entries = new Map();
  for (const source of builds) {
    validateBuild(source);
    const build = freezeBuild(source);
    if (entries.has(build.buildId)) fail();
    entries.set(build.buildId, build);
  }

  function get(buildId) {
    const build = entries.get(buildId);
    if (!build) fail();
    return build;
  }

  function getForManifest(manifest) {
    const build = get(manifest?.buildId);
    if (
      build.packageName !== manifest.piecePackage ||
      build.packageVersion !== manifest.pieceVersion ||
      build.npmIntegrity !== manifest.npmIntegrity ||
      build.upstreamSourceCommit !== manifest.upstreamSourceCommit
    ) fail();
    const action = build.actions[manifest.actionId];
    if (!action || action.classification !== manifest.expectedClassification) fail();
    return build;
  }

  return Object.freeze({
    get,
    getForManifest,
    list() {
      return Object.freeze([...entries.values()]);
    },
  });
}

export const REVIEWED_PIECE_BUILDS = createPieceBuildRegistry([HUBSPOT_0_8_10_BUILD]);
