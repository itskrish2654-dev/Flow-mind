import { resolve4 as systemResolve4, resolve6 as systemResolve6 } from "node:dns/promises";
import { isIP } from "node:net";

import { PieceRuntimeError } from "./errors.mjs";
import { isSafePublicAddress } from "./ip-policy.mjs";

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
  let timer;
  try {
    const outcomes = await Promise.race([
      Promise.allSettled([resolve4(destination.hostname), resolve6(destination.hostname)]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PieceRuntimeError("PIECE_TIMEOUT", true)), timeoutMs);
      }),
    ]);
    const records = [];
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome.status === "fulfilled") records.push(...normalize(outcome.value, index === 0 ? 4 : 6));
      else if (!noData(outcome.reason)) throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
    }
    if (records.length === 0 || !records.every((record) => isSafePublicAddress(record.address))) {
      throw new PieceRuntimeError("PIECE_EGRESS_DENIED");
    }
    return Object.freeze({
      hostname: destination.hostname,
      port: destination.port,
      pinnedAddress: records[0].address,
      family: records[0].family,
      evidence: Object.freeze(records.map(({ family, ttl }) => Object.freeze({ family, ttl, classification: "SAFE" }))),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
