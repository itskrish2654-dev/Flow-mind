import { GOOGLE_LEGACY_SHEETS_SCOPE, GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";

/** azp is the authorized party; aud is not an additional client-ID constraint. */
export function pickerAccessTokenHasRequiredGrant(input: {
  tokenInfo: unknown; expectedAudience: string;
}): boolean {
  const token = input.tokenInfo;
  if (!token || typeof token !== "object" || Array.isArray(token)) return false;
  const info = token as Record<string, unknown>;
  const authorizedParty = info.azp ?? info.issued_to ?? info.audience ?? info.aud;
  if (authorizedParty !== input.expectedAudience ||
    [info.audience, info.aud].some((value) => value !== undefined && typeof value !== "string") ||
    typeof info.scope !== "string") return false;
  const scopes = new Set(info.scope.split(/\s+/).filter(Boolean));
  return scopes.has(GOOGLE_SCOPES.driveFile) && !scopes.has(GOOGLE_LEGACY_SHEETS_SCOPE)
    && Number.isFinite(Number(info.expires_in)) && Number(info.expires_in) > 0;
}

/** Tokeninfo account fields are optional for a drive.file-only GIS token. */
export function pickerTokenAccountIdsMatchIfPresent(input: {
  tokenInfo: unknown; externalAccountId: string;
}): { present: boolean; match: boolean } {
  const info = input.tokenInfo && typeof input.tokenInfo === "object" && !Array.isArray(input.tokenInfo)
    ? input.tokenInfo as Record<string, unknown>
    : {};
  const ids = [info.user_id, info.sub].filter((value) => value !== undefined);
  return { present: ids.length > 0, match: ids.length > 0 && !!input.externalAccountId &&
    ids.every((value) => value === input.externalAccountId) };
}

/** Drive about.user identifies the bearer-token principal without broader scopes. */
export function pickerDriveAccountMatches(storedAbout: unknown, pickerAbout: unknown): boolean {
  const user = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = (value as Record<string, unknown>).user;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown> : null;
  };
  const stored = user(storedAbout);
  const picker = user(pickerAbout);
  return stored?.me === true && picker?.me === true &&
    typeof stored.permissionId === "string" && stored.permissionId.length > 0 &&
    picker.permissionId === stored.permissionId;
}

/** Retained for callers/tests that require tokeninfo to carry account identity. */
export function pickerAccessTokenMatchesConnection(input: {
  tokenInfo: unknown; expectedAudience: string; externalAccountId: string;
}): boolean {
  return pickerAccessTokenHasRequiredGrant(input) &&
    pickerTokenAccountIdsMatchIfPresent(input).match;
}
