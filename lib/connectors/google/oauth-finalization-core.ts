export type ExistingGoogleConnection = {
  id: string;
  externalAccountId: string;
  status: "connected" | "expired" | "revoked" | "error";
  lastErrorCategory: string | null;
  grantedScopes: string[];
  hasRefreshCredential: boolean;
};

export type GoogleConnectionResolution =
  | Readonly<{ mode: "discover" }>
  | Readonly<{ mode: "existing"; connectionId: string }>
  | Readonly<{ mode: "new_only" }>;

export async function resolveGoogleConnectionForFinalization<T>(
  resolution: GoogleConnectionResolution,
  loaders: {
    loadExistingById: (connectionId: string) => Promise<T | null>;
    discoverByIdentity: () => Promise<T | null>;
  },
): Promise<T | null> {
  if (resolution.mode === "new_only") return null;
  if (resolution.mode === "existing") {
    return loaders.loadExistingById(resolution.connectionId);
  }
  return loaders.discoverByIdentity();
}

export function assertGoogleReconnectAccount(
  intended: Pick<ExistingGoogleConnection, "externalAccountId"> | null,
  returnedExternalAccountId: string,
) {
  if (intended && intended.externalAccountId !== returnedExternalAccountId) {
    throw new Error("The provider returned a different account than the selected connection.");
  }
}

export function canPreserveGoogleRefreshCredential(
  existing: ExistingGoogleConnection | null,
) {
  return Boolean(
    existing?.hasRefreshCredential &&
      (existing.status === "connected" ||
        (existing.status === "expired" && existing.lastErrorCategory === null)),
  );
}

export function assertGoogleOAuthHasDurableRefresh(input: {
  existing: ExistingGoogleConnection | null;
  returnedRefreshToken?: string;
}) {
  if (!input.returnedRefreshToken && !canPreserveGoogleRefreshCredential(input.existing)) {
    throw new Error("Google did not provide a durable refresh credential. Reconnect and grant offline access.");
  }
}

export function unionGoogleScopes(existing: string[], returned: string[], excludedScope: string) {
  return Array.from(new Set([...existing, ...returned])).filter((scope) => scope !== excludedScope);
}
