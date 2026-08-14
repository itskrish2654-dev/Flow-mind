export type TurnstileBrowserCategory =
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "other";

export function classifyTurnstileError(errorCode: string): string {
  if (errorCode === "110200") return "hostname_not_authorized";
  if (errorCode === "110100") return "invalid_sitekey";
  if (errorCode === "110110") return "sitekey_not_found";
  if (errorCode === "110600" || errorCode === "challenge_timeout") return "challenge_timeout";
  if (errorCode === "200500") return "challenge_iframe_load";
  if (errorCode === "script_load_failure") return "script_load_failure";
  return "turnstile_client_error";
}
