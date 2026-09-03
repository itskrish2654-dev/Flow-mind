import { resolve4 as systemResolve4, resolve6 as systemResolve6 } from "node:dns/promises";
import { isIP } from "node:net";

import { PieceRuntimeError } from "./errors.mjs";
import { isSafePublicAddress } from "./ip-policy.mjs";

const MAX_DNS_ATTEMPTS = 2;
const DNS_RETRY_DELAY_MS = 25;
const TRANSIENT_DNS_CODES = Object.freeze([
  "ETIMEOUT",
  "ESERVFAIL",
  "EREFUSED",
  "ECONNREFUSED",
]);
const FAMILY_OUTCOME = Object.freeze({
  SAFE_RECORDS: "SAFE_RECORDS",
  NO_DATA: "NO_DATA",
  TRANSIENT_FAILURE: "TRANSIENT_FAILURE",
  FAIL_CLOSED: "FAIL_CLOSED",
});

function normalize(records, family) {
  if (!Array.isArray(records)) throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
  return records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
    }
    if (
      typeof record.address !== "string" ||
      isIP(record.address) !== family ||
      !Number.isInteger(record.ttl) ||
      record.ttl < 0 ||
      record.ttl > 86_400
    ) {
      throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
    }
    return { address: record.address, family, ttl: record.ttl };
  });
}

function noData(error) {
  return error && typeof error === "object" && ["ENODATA", "ENOTFOUND"].includes(String(error.code));
}

function transientDnsFailure(error) {
  return error && typeof error === "object" && TRANSIENT_DNS_CODES.includes(error.code);
}

function timeoutFailure() {
  return new PieceRuntimeError("PIECE_TIMEOUT", true);
}

function defaultFamilyDeadline(windowMs) {
  let timer;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, windowMs);
    }),
    cancel() {
      if (timer) clearTimeout(timer);
    },
  };
}

function classifyRecords(records, family) {
  try {
    const normalized = normalize(records, family);
    if (!normalized.every((record) => isSafePublicAddress(record.address))) {
      return { kind: FAMILY_OUTCOME.FAIL_CLOSED, records: [] };
    }
    return normalized.length > 0
      ? { kind: FAMILY_OUTCOME.SAFE_RECORDS, records: normalized }
      : { kind: FAMILY_OUTCOME.NO_DATA, records: [] };
  } catch {
    return { kind: FAMILY_OUTCOME.FAIL_CLOSED, records: [] };
  }
}

function classifyResolverError(error) {
  if (noData(error)) return { kind: FAMILY_OUTCOME.NO_DATA, records: [] };
  if (transientDnsFailure(error)) return { kind: FAMILY_OUTCOME.TRANSIENT_FAILURE, records: [] };
  return { kind: FAMILY_OUTCOME.FAIL_CLOSED, records: [] };
}

function createFamilyResolution({ resolver, hostname, family, windowMs, attempt, createFamilyDeadline }) {
  let cancelResolution;
  const cancellation = new Promise((resolve) => {
    cancelResolution = () => resolve({ kind: FAMILY_OUTCOME.TRANSIENT_FAILURE, records: [] });
  });
  const resolverOutcome = Promise.resolve()
    .then(() => resolver(hostname))
    .then(
      (records) => classifyRecords(records, family),
      (error) => classifyResolverError(error),
    );
  const deadline = createFamilyDeadline(windowMs, { attempt, family });
  const deadlineOutcome = Promise.resolve(deadline.promise).then(
    () => ({ kind: FAMILY_OUTCOME.TRANSIENT_FAILURE, records: [] }),
    () => ({ kind: FAMILY_OUTCOME.FAIL_CLOSED, records: [] }),
  );
  const promise = Promise.race([resolverOutcome, deadlineOutcome, cancellation])
    .finally(() => deadline.cancel());
  return { promise, cancel: cancelResolution };
}

async function resolveFamilyPair({ resolve4, resolve6, hostname, windowMs, attempt, createFamilyDeadline }) {
  const tasks = [
    createFamilyResolution({ resolver: resolve4, hostname, family: 4, windowMs, attempt, createFamilyDeadline }),
    createFamilyResolution({ resolver: resolve6, hostname, family: 6, windowMs, attempt, createFamilyDeadline }),
  ];
  const first = await Promise.race(tasks.map((task, index) => task.promise.then((outcome) => ({ index, outcome }))));
  if (first.outcome.kind === FAMILY_OUTCOME.FAIL_CLOSED) {
    const siblingIndex = first.index === 0 ? 1 : 0;
    tasks[siblingIndex].cancel();
    await tasks[siblingIndex].promise;
    return first.index === 0
      ? [first.outcome, { kind: FAMILY_OUTCOME.TRANSIENT_FAILURE, records: [] }]
      : [{ kind: FAMILY_OUTCOME.TRANSIENT_FAILURE, records: [] }, first.outcome];
  }
  const siblingIndex = first.index === 0 ? 1 : 0;
  const sibling = await tasks[siblingIndex].promise;
  return first.index === 0 ? [first.outcome, sibling] : [sibling, first.outcome];
}

function attemptTiming(remainingMs, attemptsRemaining) {
  const wholeRemainingMs = Math.floor(remainingMs);
  if (wholeRemainingMs < 1) throw timeoutFailure();
  if (attemptsRemaining === 1) {
    return { windowMs: wholeRemainingMs, retryDelayMs: 0 };
  }
  const retryDelayMs = Math.min(
    DNS_RETRY_DELAY_MS,
    Math.max(0, wholeRemainingMs - attemptsRemaining),
  );
  const windowMs = Math.floor((wholeRemainingMs - retryDelayMs) / attemptsRemaining);
  if (windowMs < 1) throw timeoutFailure();
  return { windowMs, retryDelayMs };
}

export async function resolveManifestDestination(destination, dependencies = {}) {
  if (
    !destination ||
    destination.protocol !== "tls" ||
    destination.port !== 443 ||
    typeof destination.hostname !== "string" ||
    destination.hostname.length < 1 ||
    destination.hostname.includes("*") ||
    isIP(destination.hostname) !== 0
  ) {
    throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
  }
  const resolve4 = dependencies.resolve4 ?? ((hostname) => systemResolve4(hostname, { ttl: true }));
  const resolve6 = dependencies.resolve6 ?? ((hostname) => systemResolve6(hostname, { ttl: true }));
  const timeoutMs = dependencies.timeoutMs ?? 1_500;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const createFamilyDeadline = dependencies.createFamilyDeadline ?? defaultFamilyDeadline;
  const deadline = now() + timeoutMs;

  for (let attempt = 1; attempt <= MAX_DNS_ATTEMPTS; attempt += 1) {
    const timing = attemptTiming(deadline - now(), MAX_DNS_ATTEMPTS - attempt + 1);
    const outcomes = await resolveFamilyPair({
      resolve4,
      resolve6,
      hostname: destination.hostname,
      windowMs: timing.windowMs,
      attempt,
      createFamilyDeadline,
    });
    if (now() >= deadline) throw timeoutFailure();
    if (outcomes.some((outcome) => outcome.kind === FAMILY_OUTCOME.FAIL_CLOSED)) {
      throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
    }
    const records = outcomes.flatMap((outcome) => outcome.records);
    if (records.length > 0) {
      return Object.freeze({
        hostname: destination.hostname,
        port: destination.port,
        pinnedAddress: records[0].address,
        family: records[0].family,
        evidence: Object.freeze(records.map(({ family, ttl }) => Object.freeze({ family, ttl, classification: "SAFE" }))),
      });
    }
    if (attempt === MAX_DNS_ATTEMPTS) break;
    const remainingMs = deadline - now();
    const delayMs = Math.min(timing.retryDelayMs, Math.max(0, Math.floor(remainingMs) - 1));
    if (delayMs > 0) await sleep(delayMs);
    if (now() >= deadline) throw timeoutFailure();
  }
  throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
}
