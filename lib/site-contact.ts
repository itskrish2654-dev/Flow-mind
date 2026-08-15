import "server-only";

export const DEFAULT_SUPPORT_EMAIL = "contact@crazy-loops.com";

export function getSupportEmail(): string {
  const value = process.env.SUPPORT_EMAIL?.trim();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : DEFAULT_SUPPORT_EMAIL;
}
