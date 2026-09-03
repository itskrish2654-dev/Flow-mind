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

async function settleWithinDeadline(resolvers, deadline, now) {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) throw timeoutFailure();
  let timer;
  try {
    const outcomes = await Promise.race([
      Promise.allSettled(resolvers.map((resolver) => Promise.resolve().then(resolver))),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutFailure()), remainingMs);
      }),
    ]);
    if (now() >= deadline) throw timeoutFailure();
    return outcomes;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validatedRecords(outcomes) {
  const records = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (outcome.status === "fulfilled") {
      records.push(...normalize(outcome.value, index === 0 ? 4 : 6));
    }
  }
  if (!records.every((record) => isSafePublicAddress(record.address))) {
    throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
  }
  for (const outcome of outcomes) {
    if (outcome.status === "rejected" && !noData(outcome.reason) && !transientDnsFailure(outcome.reason)) {
      throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
    }
  }
  return records;
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
  const deadline = now() + timeoutMs;

  for (let attempt = 1; attempt <= MAX_DNS_ATTEMPTS; attempt += 1) {
    const outcomes = await settleWithinDeadline(
      [() => resolve4(destination.hostname), () => resolve6(destination.hostname)],
      deadline,
      now,
    );
    const records = validatedRecords(outcomes);
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
    if (remainingMs <= 0) throw timeoutFailure();
    const delayMs = Math.min(DNS_RETRY_DELAY_MS, Math.max(0, remainingMs - 1));
    if (delayMs > 0) await sleep(delayMs);
    if (now() >= deadline) throw timeoutFailure();
  }
  throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
}
