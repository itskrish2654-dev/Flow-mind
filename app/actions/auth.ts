"use server";

import { z } from "zod";

import { SECURITY_LIMITS, SecurityGateError, enforceRateLimit } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";
import { createClient } from "@/lib/supabase/server";
import { trackProductEvent } from "@/lib/observability";
import { getSiteOrigin } from "@/lib/site-origin";

const EmailSchema = z.string().trim().email().max(320);
const CaptchaTokenSchema = z.string().min(1).max(4_096);
const StrongPasswordSchema = z.string()
  .min(12, "Use at least 12 characters.")
  .max(256)
  .regex(/[a-z]/, "Add a lowercase letter.")
  .regex(/[A-Z]/, "Add an uppercase letter.")
  .regex(/[0-9]/, "Add a number.")
  .regex(/[^A-Za-z0-9]/, "Add a symbol.");
const AuthRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.enum(["login", "signup"]),
    email: EmailSchema,
    password: z.string().min(8).max(256),
    captchaToken: CaptchaTokenSchema,
  }),
  z.object({
    mode: z.literal("recovery"),
    email: EmailSchema,
    captchaToken: CaptchaTokenSchema,
  }),
]);

export type AuthenticateResult =
  | { ok: true; sessionCreated: boolean; notice?: string }
  | { ok: false; error: string };

export async function authenticateWithPassword(input: {
  mode: "login" | "signup" | "recovery";
  email: string;
  password?: string;
  captchaToken: string;
}): Promise<AuthenticateResult> {
  const parsed = AuthRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: input.captchaToken
        ? "Enter valid account details."
        : "Complete the security challenge and try again.",
    };
  }
  const email = parsed.data.email.toLowerCase();
  try {
    const ip = await getClientIp();
    const rule = SECURITY_LIMITS[parsed.data.mode];
    // Defense in depth only. Supabase Auth's CAPTCHA validation is the
    // authoritative boundary because direct Auth endpoints bypass this action.
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
      options: { captchaToken: parsed.data.captchaToken },
    });
    if (error) {
      return {
        ok: false,
        error: /captcha/i.test(`${error.code ?? ""} ${error.message}`)
          ? "The security challenge could not be verified. Please try again."
          : "Email or password is incorrect.",
      };
    }
    const { data: { user } } = await supabase.auth.getUser();
    await trackProductEvent({ event: "login_completed", userId: user?.id });
    return { ok: true, sessionCreated: true };
  }

  const siteUrl = getSiteOrigin();
  if (parsed.data.mode === "recovery") {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      captchaToken: parsed.data.captchaToken,
      ...(siteUrl ? { redirectTo: `${siteUrl}/auth/recovery` } : {}),
    });
    if (error) {
      return {
        ok: false,
        error: /captcha/i.test(`${error.code ?? ""} ${error.message}`)
          ? "The security challenge could not be verified. Please try again."
          : "A recovery email could not be requested right now.",
      };
    }
    await trackProductEvent({ event: "recovery_requested" });
    return {
      ok: true,
      sessionCreated: false,
      notice: "If an account exists for that email, a recovery link is on its way.",
    };
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password: parsed.data.password,
    options: {
      captchaToken: parsed.data.captchaToken,
      ...(siteUrl ? { emailRedirectTo: `${siteUrl}/auth/callback` } : {}),
    },
  });
  if (error) {
    return {
      ok: false,
      error: /captcha/i.test(`${error.code ?? ""} ${error.message}`)
        ? "The security challenge could not be verified. Please try again."
        : "Account creation could not be completed.",
    };
  }
  await trackProductEvent({ event: "signup_completed", userId: data.user?.id });
  return data.session
    ? { ok: true, sessionCreated: true }
    : {
        ok: true,
        sessionCreated: false,
        notice: "Check your email to confirm your account, then return here to sign in.",
      };
}

export type UpdatePasswordResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateRecoveredPassword(input: {
  password: string;
  confirmation: string;
}): Promise<UpdatePasswordResult> {
  const parsed = z.object({
    password: StrongPasswordSchema,
    confirmation: z.string().max(256),
  }).safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a stronger password." };
  }
  if (parsed.data.password !== parsed.data.confirmation) {
    return { ok: false, error: "The passwords do not match." };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: "This recovery link is invalid or has expired. Request a new one." };
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { ok: false, error: "Your password could not be updated. Request a new recovery link." };
  }
  await supabase.auth.signOut({ scope: "global" });
  return { ok: true };
}
