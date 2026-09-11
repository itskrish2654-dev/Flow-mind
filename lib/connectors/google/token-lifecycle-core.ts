export type GoogleConnectionTokenState = {
  status: "connected" | "expired" | "revoked" | "error";
  tokenExpiresAt: string | null;
  lastErrorCategory: string | null;
};

export type GoogleTokenDecision = "use_access_token" | "refresh" | "reconnect";

export function decideGoogleTokenAction(
  connection: GoogleConnectionTokenState,
  now = Date.now(),
): GoogleTokenDecision {
  if (connection.status === "connected") {
    if (
      connection.tokenExpiresAt &&
      Number.isFinite(Date.parse(connection.tokenExpiresAt)) &&
      Date.parse(connection.tokenExpiresAt) >= now + 60_000
    ) {
      return "use_access_token";
    }
    return "refresh";
  }

  // Legacy maintenance may have marked an otherwise healthy Google connection
  // expired solely because its short-lived access token elapsed. A null error
  // category is the existing durable signal that no terminal provider failure
  // has been proven. Authentication/authorization failures stay fail-closed.
  if (connection.status === "expired" && connection.lastErrorCategory === null) {
    return "refresh";
  }

  return "reconnect";
}

export type TokenRefreshResult =
  | { refreshed: true; expiresAt: string }
  | { refreshed: false; reason: "refresh_in_progress" };

export type RefreshTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  grantedScopes?: string[];
};

export type TokenRefreshOperations = {
  claimLease: () => Promise<boolean>;
  readRefreshToken: () => Promise<string>;
  requestTokens: (refreshToken: string) => Promise<RefreshTokens>;
  finalizeTokens: (tokens: RefreshTokens) => Promise<void>;
  isReconnectRequiredError: (error: unknown) => boolean;
  markReconnectRequired: () => Promise<void>;
  releaseLease: () => Promise<void>;
};

export async function runTokenRefresh(
  operations: TokenRefreshOperations,
): Promise<TokenRefreshResult> {
  if (!(await operations.claimLease())) {
    return { refreshed: false, reason: "refresh_in_progress" };
  }

  try {
    let refreshToken: string;
    try {
      refreshToken = await operations.readRefreshToken();
      if (!refreshToken) throw new Error("Connection refresh credential is unavailable.");
    } catch (error) {
      await operations.markReconnectRequired();
      throw error;
    }

    let tokens: RefreshTokens;
    try {
      tokens = await operations.requestTokens(refreshToken);
    } catch (error) {
      if (operations.isReconnectRequiredError(error)) {
        await operations.markReconnectRequired();
      }
      throw error;
    }
    if (!tokens.accessToken || !tokens.expiresAt) {
      throw new Error("Provider returned incomplete refresh credentials.");
    }
    await operations.finalizeTokens(tokens);
    return { refreshed: true, expiresAt: tokens.expiresAt };
  } finally {
    await operations.releaseLease();
  }
}
