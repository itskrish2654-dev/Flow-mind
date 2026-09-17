const DISABLED_AUTH_CAPTCHA_MODE = "disabled";

export function isAuthCaptchaRequired() {
  // Deliberately exact and fail-closed: every absent or unknown value requires CAPTCHA.
  return process.env.FLOWMIND_AUTH_CAPTCHA_MODE !== DISABLED_AUTH_CAPTCHA_MODE;
}

export function isAuthCaptchaTokenAccepted(
  captchaRequired: boolean,
  captchaToken: unknown,
) {
  if (!captchaRequired) return true;
  return typeof captchaToken === "string"
    && captchaToken.length >= 1
    && captchaToken.length <= 4_096;
}

export function getSupabaseAuthCaptchaOptions(
  captchaRequired: boolean,
  captchaToken: unknown,
): { captchaToken: string } | Record<string, never> {
  if (!captchaRequired) return {};
  if (!isAuthCaptchaTokenAccepted(true, captchaToken)) {
    throw new Error("Auth CAPTCHA token is required.");
  }
  return { captchaToken: captchaToken as string };
}
