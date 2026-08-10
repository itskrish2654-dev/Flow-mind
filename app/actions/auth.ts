"use server";

import { z } from "zod";

import { SECURITY_LIMITS, SecurityGateError, enforceRateLimit } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";
import { createClient } from "@/lib/supabase/server";

const AuthRequestSchema = z.object({
  mode: z.enum(["login", "signup"]),
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(256),
});

export type AuthenticateResult =
  | { ok: true; sessionCreated: boolean; notice?: string }
  | { ok: false; error: string };

export async function authenticateWithPassword(input: {
  mode: "login" | "signup";
  email: string;
  password: string;
}): Promise<AuthenticateResult> {
  const parsed = AuthRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a valid email and password." };
  const email = parsed.data.email.toLowerCase();
  try {
    const ip = await getClientIp();
    const rule = parsed.data.mode === "signup" ? SECURITY_LIMITS.signup : SECURITY_LIMITS.login;
    await enforceRateLimit(`${parsed.data.mode}-ip`, [ip], rule);
    await enforceRateLimit(`${parsed.data.mode}-email`, [email], rule);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SecurityGateError ? error.message : "Authentication is temporarily unavailable.",
    };
  }

  const supabase = await createClient();
  if (parsed.data.mode === "login") {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: parsed.data.password,
    });
    return error
      ? { ok: false, error: "Email or password is incorrect." }
      : { ok: true, sessionCreated: true };
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  const { data, error } = await supabase.auth.signUp({
    email,
    password: parsed.data.password,
    options: siteUrl ? { emailRedirectTo: `${siteUrl}/auth/callback` } : undefined,
  });
  if (error) return { ok: false, error: "Account creation could not be completed." };
  return data.session
    ? { ok: true, sessionCreated: true }
    : {
        ok: true,
        sessionCreated: false,
        notice: "Check your email to confirm your account, then return here to sign in.",
      };
}
