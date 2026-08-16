"use server";

import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { getCapability } from "@/lib/capability-registry";
import { trackProductEvent } from "@/lib/observability";
import { enforceRateLimit } from "@/lib/security/limits";
import { createAdminClient } from "@/lib/supabase/admin";

const RequestSchema = z.object({
  capabilityId: z.string().min(1).max(80),
  source: z.enum(["homepage_demo", "workflow_builder", "connections_page"]),
});

function providerName(capabilityId: string, displayName: string) {
  const normalized = capabilityId === "external_integration" ? displayName : capabilityId.replace(/[_-].*$/, "");
  return normalized.toLowerCase().replace(/[^a-z0-9 _.-]/g, "").slice(0, 80);
}

export async function requestConnectorCapability(input: { capabilityId: string; source: "homepage_demo" | "workflow_builder" | "connections_page" }) {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "That connector request is invalid." };
  const capability = getCapability(parsed.data.capabilityId);
  if (!capability || capability.supported) return { ok: false as const, error: "This capability is already available or cannot be requested." };

  const auth = await getAuthenticatedContext();
  const cookieStore = await cookies();
  let anonymousId = cookieStore.get("crazyloops_demand_id")?.value;
  if (!auth && !anonymousId) {
    anonymousId = randomUUID();
    cookieStore.set("crazyloops_demand_id", anonymousId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  const identity = auth?.user.id ?? anonymousId;
  const secret = process.env.FLOWMIND_RATE_LIMIT_SECRET;
  if (!identity || !secret) return { ok: false as const, error: "Connector requests are temporarily unavailable." };
  await enforceRateLimit("connector-request", [identity], { limit: 20, windowSeconds: 60 * 60 });
  const requesterHash = createHmac("sha256", secret).update(identity).digest("hex");
  const provider = providerName(capability.id, capability.displayName);
  const { error } = await createAdminClient().rpc("record_connector_capability_request", {
    p_requester_hash: requesterHash,
    p_user_id: auth?.user.id ?? null,
    p_requested_provider: provider,
    p_requested_capability: capability.id,
    p_source: parsed.data.source,
  });
  if (error) return { ok: false as const, error: "Your request could not be recorded." };
  await trackProductEvent({ event: "connector_requested", userId: auth?.user.id, properties: { source: parsed.data.source, requester_type: auth ? "authenticated" : "anonymous" } });
  return { ok: true as const, message: "Requested. We'll use this to decide what gets built next." };
}
