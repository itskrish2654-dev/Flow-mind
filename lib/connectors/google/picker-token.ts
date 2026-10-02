import { GOOGLE_LEGACY_SHEETS_SCOPE, GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";

/** Google OAuth2 access-token tokeninfo uses audience/issued_to/user_id, not ID-token aud/sub. */
export function pickerAccessTokenMatchesConnection(input: {
  tokenInfo: unknown; expectedAudience: string; externalAccountId: string;
}): boolean {
  const token = input.tokenInfo;
  if (!token || typeof token !== "object" || Array.isArray(token)) return false;
  const info = token as Record<string, unknown>;
  const audiences = [info.audience, info.issued_to].filter((value): value is string =>
    typeof value === "string" && value.length > 0);
  if (!audiences.length || audiences.some((value) => value !== input.expectedAudience)) return false;
  if (info.user_id !== input.externalAccountId || typeof info.scope !== "string") return false;
  const scopes = new Set(info.scope.split(/\s+/).filter(Boolean));
  return scopes.has(GOOGLE_SCOPES.driveFile) && !scopes.has(GOOGLE_LEGACY_SHEETS_SCOPE)
    && Number.isFinite(Number(info.expires_in)) && Number(info.expires_in) > 0;
}
