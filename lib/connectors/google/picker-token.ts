import { GOOGLE_LEGACY_SHEETS_SCOPE, GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";

/** Boolean-only staging evidence. Never return tokeninfo values or account identifiers. */
export function pickerTokenValidationDiagnostics(input: {
  tokenInfo: unknown; expectedAudience: string; externalAccountId: string;
}) {
  const info = input.tokenInfo && typeof input.tokenInfo === "object" && !Array.isArray(input.tokenInfo)
    ? input.tokenInfo as Record<string, unknown>
    : {};
  const scopes = typeof info.scope === "string" ? new Set(info.scope.split(/\s+/).filter(Boolean)) : new Set<string>();
  return {
    audiencePresent: info.audience !== undefined,
    issuedToPresent: info.issued_to !== undefined,
    audPresent: info.aud !== undefined,
    azpPresent: info.azp !== undefined,
    userIdPresent: info.user_id !== undefined,
    subPresent: info.sub !== undefined,
    audienceMatchesExpectedClient: info.audience === input.expectedAudience,
    issuedToMatchesExpectedClient: info.issued_to === input.expectedAudience,
    audMatchesExpectedClient: info.aud === input.expectedAudience,
    azpMatchesExpectedClient: info.azp === input.expectedAudience,
    userIdMatchesStoredAccount: info.user_id === input.externalAccountId,
    subMatchesStoredAccount: info.sub === input.externalAccountId,
    driveFileScopePresent: scopes.has(GOOGLE_SCOPES.driveFile),
    legacySheetsScopeAbsent: !scopes.has(GOOGLE_LEGACY_SHEETS_SCOPE),
    notExpired: Number.isFinite(Number(info.expires_in)) && Number(info.expires_in) > 0,
  };
}

/** Google access-token tokeninfo may use legacy or current client/account field names. */
export function pickerAccessTokenMatchesConnection(input: {
  tokenInfo: unknown; expectedAudience: string; externalAccountId: string;
}): boolean {
  const token = input.tokenInfo;
  if (!token || typeof token !== "object" || Array.isArray(token)) return false;
  const info = token as Record<string, unknown>;
  const audiences = [info.audience, info.issued_to, info.aud, info.azp].filter((value) => value !== undefined);
  if (!audiences.length || audiences.some((value) => value !== input.expectedAudience)) return false;
  const accountIds = [info.user_id, info.sub].filter((value) => value !== undefined);
  if (!accountIds.length || accountIds.some((value) => value !== input.externalAccountId) ||
    typeof info.scope !== "string") return false;
  const scopes = new Set(info.scope.split(/\s+/).filter(Boolean));
  return scopes.has(GOOGLE_SCOPES.driveFile) && !scopes.has(GOOGLE_LEGACY_SHEETS_SCOPE)
    && Number.isFinite(Number(info.expires_in)) && Number(info.expires_in) > 0;
}
