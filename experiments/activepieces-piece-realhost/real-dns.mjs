import { resolve4 as systemResolve4, resolve6 as systemResolve6 } from "node:dns/promises";
import { isIP } from "node:net";

import { isSafePublicAddress } from "./ip-policy.mjs";

const EXPECTED_HOSTNAME = "api.hubapi.com";

function dnsFailure(category) {
  const error = new Error(category);
  error.category = category;
  return error;
}

function normalizeRecords(value, family) {
  if (!Array.isArray(value)) throw dnsFailure("EGRESS_DNS_FAILED");
  return value.map((record) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw dnsFailure("EGRESS_DNS_FAILED");
    }
    const address = record.address;
    const ttl = record.ttl;
    if (typeof address !== "string" || !Number.isInteger(ttl) || ttl < 0 || ttl > 86_400) {
      throw dnsFailure("EGRESS_DNS_FAILED");
    }
    if (isIP(address) !== family) throw dnsFailure("EGRESS_DNS_FAILED");
    return { address, family, ttl, safe: isSafePublicAddress(address) };
  });
}

function isNoData(error) {
  return error && typeof error === "object" && "code" in error && ["ENODATA", "ENOTFOUND"].includes(String(error.code));
}

export async function resolveApprovedHostname(options = {}) {
  const hostname = options.hostname ?? EXPECTED_HOSTNAME;
  if (hostname !== EXPECTED_HOSTNAME) throw dnsFailure("EGRESS_DESTINATION_DENIED");
  const resolve4 = options.resolve4 ?? ((name) => systemResolve4(name, { ttl: true }));
  const resolve6 = options.resolve6 ?? ((name) => systemResolve6(name, { ttl: true }));
  const timeoutMs = options.timeoutMs ?? 1_500;
  let timeout;
  try {
    const outcomes = await Promise.race([
      Promise.allSettled([resolve4(hostname), resolve6(hostname)]),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(dnsFailure("EGRESS_TIMEOUT")), timeoutMs);
      }),
    ]);
    const records = [];
    for (let index = 0; index < outcomes.length; index += 1) {
      const outcome = outcomes[index];
      if (outcome.status === "fulfilled") {
        records.push(...normalizeRecords(outcome.value, index === 0 ? 4 : 6));
      } else if (!isNoData(outcome.reason)) {
        throw dnsFailure(outcome.reason?.category === "EGRESS_TIMEOUT" ? "EGRESS_TIMEOUT" : "EGRESS_DNS_FAILED");
      }
    }
    if (records.length === 0) throw dnsFailure("EGRESS_DNS_FAILED");
    if (!records.every((record) => record.safe)) throw dnsFailure("EGRESS_DNS_DENIED");
    return {
      hostname,
      pinnedAddress: records[0].address,
      family: records[0].family,
      evidence: records.map(({ family, ttl, safe }) => ({ family, ttl, classification: safe ? "SAFE" : "UNSAFE" })),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export const REAL_DNS_HOSTNAME = EXPECTED_HOSTNAME;
