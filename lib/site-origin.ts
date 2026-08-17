export const CANONICAL_PRODUCTION_ORIGIN = "https://www.crazy-loops.com";
export const LEGACY_PRODUCTION_ORIGIN = "https://flow-mind-beta.vercel.app";

type SiteOriginInput = {
  siteUrl?: string | null;
  vercelUrl?: string | null;
  vercelEnvironment?: string | null;
  fallbackOrigin?: string | null;
};

function normalizeOrigin(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("The public site origin is invalid.");
  }
  return parsed.origin;
}

export function resolveSiteOrigin(input: SiteOriginInput = {}) {
  if (input.vercelEnvironment === "production") {
    return CANONICAL_PRODUCTION_ORIGIN;
  }

  const candidate = input.siteUrl?.trim()
    || input.fallbackOrigin?.trim()
    || input.vercelUrl?.trim();
  if (!candidate) throw new Error("The public site origin is not configured.");
  const origin = normalizeOrigin(candidate);
  return origin === LEGACY_PRODUCTION_ORIGIN
    ? CANONICAL_PRODUCTION_ORIGIN
    : origin;
}

export function getSiteOrigin(fallbackOrigin?: string) {
  return resolveSiteOrigin({
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    vercelUrl: process.env.VERCEL_URL,
    vercelEnvironment: process.env.VERCEL_ENV,
    fallbackOrigin,
  });
}

export function getSiteUrl(path: string, fallbackOrigin?: string) {
  return new URL(path, getSiteOrigin(fallbackOrigin)).toString();
}
