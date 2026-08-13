import "server-only";

export const SUPPORT_EMAIL_PLACEHOLDER = "[SUPPORT EMAIL — OWNER MUST CONFIGURE BEFORE PUBLIC LAUNCH]";

export function getSupportEmail(): string | null {
  const value = process.env.SUPPORT_EMAIL?.trim();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}
