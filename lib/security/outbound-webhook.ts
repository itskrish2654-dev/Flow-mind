import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DNS_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  if (values.some((value) => value < 0 || value > 255)) return null;
  return (((values[0] * 256 + values[1]) * 256 + values[2]) * 256 + values[3]) >>> 0;
}

function inIpv4Cidr(address: number, base: string, bits: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return true;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isBlockedOutboundAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  const family = isIP(normalized);
  if (family === 4) {
    const numeric = ipv4Number(normalized);
    return numeric === null || BLOCKED_IPV4.some(([base, bits]) => inIpv4Cidr(numeric, base, bits));
  }
  if (family === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8") ||
      normalized.startsWith("::ffff:")
    );
  }
  return true;
}

export function parseTrustedWebhookUrl(value: string): URL {
  let destination: URL;
  try {
    destination = new URL(value);
  } catch {
    throw new Error("Webhook URL is invalid.");
  }
  const hostname = destination.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    destination.protocol !== "https:" ||
    destination.username ||
    destination.password ||
    destination.hash ||
    (destination.port && destination.port !== "443") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (isIP(hostname) > 0 && isBlockedOutboundAddress(hostname))
  ) {
    throw new Error("Webhook destination is not permitted.");
  }
  return destination;
}

export function selectPinnedWebhookAddress(
  addresses: Array<{ address: string; family: number }>,
): { address: string; family: 4 | 6 } {
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
}

export function createPinnedWebhookLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export async function resolveTrustedWebhook(value: string): Promise<{
  destination: URL;
  address: string;
  family: 4 | 6;
}> {
  const destination = parseTrustedWebhookUrl(value);
  const hostname = destination.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    return { destination, address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const addresses = await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Webhook DNS lookup timed out.")), DNS_TIMEOUT_MS),
    ),
  ]);
  if (!addresses.length || addresses.some(({ address }) => isBlockedOutboundAddress(address))) {
    throw new Error("Webhook destination resolves to a blocked network.");
  }
  // Vercel functions do not consistently have outbound IPv6 connectivity.
  // Keep DNS pinning, but prefer a validated public IPv4 answer when available.
  const pinned = selectPinnedWebhookAddress(addresses);
  return { destination, address: pinned.address, family: pinned.family as 4 | 6 };
}

export async function postTrustedWebhook(
  endpoint: string,
  payload: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; referenceId?: string }> {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("Webhook request body is too large.");
  const { destination, address, family } = await resolveTrustedWebhook(endpoint);

  return new Promise((resolve, reject) => {
    const outbound = request(
      destination,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.byteLength,
          "User-Agent": "CrazyLoops-Webhook/1.0",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        timeout: REQUEST_TIMEOUT_MS,
        lookup: createPinnedWebhookLookup(address, family),
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Webhook response is too large."));
          }
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (!isAcknowledgedWebhookStatus(status)) {
            reject(new Error(`Webhook returned status ${status}.`));
            return;
          }
          resolve({
            status,
            referenceId: response.headers["x-request-id"]?.toString(),
          });
        });
        response.on("error", reject);
      },
    );
    outbound.on("timeout", () => outbound.destroy(new Error("Webhook request timed out.")));
    outbound.on("error", reject);
    outbound.end(body);
  });
}

export function isAcknowledgedWebhookStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
