"use server";

import { cookies } from "next/headers";
import { z } from "zod";

import {
  HOMEPAGE_DEMO_MAX_PROMPT_LENGTH,
  planHomepageDemo,
  type HomepageDemoResult,
} from "@/lib/homepage-demo";
import {
  captureOperationalEvent,
  trackProductEvent,
} from "@/lib/observability";
import {
  HOMEPAGE_DEMO_DRAFT_COOKIE,
  HOMEPAGE_DEMO_DRAFT_TTL_SECONDS,
  sealHomepageDemoDraft,
} from "@/lib/security/homepage-demo-draft";
import { SECURITY_LIMITS, SecurityGateError, enforceRateLimit } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";

const PreviewSchema = z.object({
  prompt: z.string().trim().min(4).max(HOMEPAGE_DEMO_MAX_PROMPT_LENGTH),
  clarification: z.string().trim().max(240).optional(),
  clarificationTurn: z.number().int().min(0).max(1).default(0),
});

export type HomepageDemoActionResult =
  | { ok: true; result: HomepageDemoResult }
  | { ok: false; error: string; rateLimited?: boolean };

function capabilityCategories(result: HomepageDemoResult): string {
  return result.status === "supported"
    ? Array.from(new Set(result.steps.map(({ category }) => category))).join(",")
    : result.status;
}

export async function previewHomepageDemo(input: {
  prompt: string;
  clarification?: string;
  clarificationTurn?: number;
}): Promise<HomepageDemoActionResult> {
  const parsed = PreviewSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `Describe the loop in 4–${HOMEPAGE_DEMO_MAX_PROMPT_LENGTH} characters.` };
  }

  const ip = await getClientIp();
  const startedAt = Date.now();
  try {
    await enforceRateLimit("homepage-demo", [ip], SECURITY_LIMITS.homepageDemo);
    await trackProductEvent({
      event: "homepage_demo_started",
      anonymousId: ip,
      properties: { source: "homepage" },
    });
    await trackProductEvent({
      event: "homepage_demo_submitted",
      anonymousId: ip,
      properties: { source: "homepage" },
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      Promise.resolve().then(() => planHomepageDemo(
        parsed.data.prompt,
        parsed.data.clarification,
        parsed.data.clarificationTurn,
      )),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Planner preview timed out.")), 2_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    const event = result.status === "supported"
      ? "homepage_demo_supported"
      : result.status === "unsupported"
        ? "homepage_demo_unsupported"
        : "homepage_demo_clarification";
    await trackProductEvent({
      event,
      anonymousId: ip,
      properties: {
        planner_status: result.plannerStatus,
        step_count: result.status === "supported" ? result.steps.length : 0,
        category: capabilityCategories(result),
        duration_ms: Date.now() - startedAt,
      },
    });
    return { ok: true, result };
  } catch (error) {
    const rateLimited = error instanceof SecurityGateError && error.code === "RATE_LIMITED";
    await captureOperationalEvent({
      level: rateLimited ? "warn" : "error",
      event: rateLimited ? "homepage_demo_rate_limited" : "homepage_demo_failed",
      durationMs: Date.now() - startedAt,
      status: "failed",
      errorCategory: rateLimited ? "rate_limit" : "planner",
      metadata: { source: "homepage" },
    });
    return {
      ok: false,
      error: rateLimited
        ? "You’ve previewed several loops. Please wait a minute and try again."
        : "The preview is temporarily unavailable. Nothing ran—please try again.",
      ...(rateLimited ? { rateLimited: true } : {}),
    };
  }
}

export async function preserveHomepageDemoDraft(input: {
  prompt: string;
}): Promise<{ ok: true; href: string } | { ok: false; error: string }> {
  const parsed = z.object({
    prompt: z.string().trim().min(4).max(HOMEPAGE_DEMO_MAX_PROMPT_LENGTH),
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "This draft cannot be saved safely." };

  try {
    const ip = await getClientIp();
    await enforceRateLimit("homepage-demo-draft", [ip], SECURITY_LIMITS.homepageDemoDraft);
    const token = sealHomepageDemoDraft(parsed.data.prompt);
    const cookieStore = await cookies();
    cookieStore.set(HOMEPAGE_DEMO_DRAFT_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: HOMEPAGE_DEMO_DRAFT_TTL_SECONDS,
    });
    await trackProductEvent({
      event: "homepage_demo_build_clicked",
      anonymousId: ip,
      properties: { source: "homepage" },
    });
    return { ok: true, href: "/login?mode=signup&next=%2Fdashboard" };
  } catch {
    return { ok: false, error: "The draft could not be preserved safely. Please try again." };
  }
}

export async function clearHomepageDemoDraft(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(HOMEPAGE_DEMO_DRAFT_COOKIE);
}
