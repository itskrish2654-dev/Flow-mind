"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { classifyTurnstileError } from "@/lib/turnstile-diagnostics";
import { captureOperationalEvent } from "@/lib/observability";
import { SECURITY_LIMITS, enforceRateLimit } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";

const TurnstileDiagnosticSchema = z.object({
  errorCode: z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/i),
  hostname: z.string().trim().min(1).max(253),
  page: z.string().trim().min(1).max(160).startsWith("/"),
  browserCategory: z.enum(["chrome", "edge", "firefox", "safari", "other"]),
  correlationId: z.string().uuid(),
});

export async function reportTurnstileClientError(input: {
  errorCode: string;
  hostname: string;
  page: string;
  browserCategory: "chrome" | "edge" | "firefox" | "safari" | "other";
  correlationId: string;
}): Promise<void> {
  const parsed = TurnstileDiagnosticSchema.safeParse(input);
  if (!parsed.success) return;

  try {
    const ip = await getClientIp();
    await enforceRateLimit(
      "turnstile-client-diagnostic",
      [ip],
      SECURITY_LIMITS.turnstileDiagnostics,
    );
    const requestHeaders = await headers();
    const requestHost = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "unknown")
      .split(",")[0]
      .trim()
      .slice(0, 253);
    await captureOperationalEvent({
      level: "warn",
      event: "turnstile_client_error",
      requestId: parsed.data.correlationId,
      status: "failed",
      errorCategory: classifyTurnstileError(parsed.data.errorCode),
      metadata: {
        turnstileErrorCode: parsed.data.errorCode,
        hostname: parsed.data.hostname,
        requestHost,
        page: parsed.data.page,
        browserCategory: parsed.data.browserCategory,
      },
    });
  } catch {
    // Authentication must not depend on diagnostic persistence.
  }
}
