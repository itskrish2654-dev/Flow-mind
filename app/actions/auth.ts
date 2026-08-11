"use server";

import { z } from "zod";

import { SECURITY_LIMITS, SecurityGateError, enforceRateLimit } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";
import { createClient } from "@/lib/supabase/server";

const EmailSchema = z.string().trim().email().max(320);
const CaptchaTokenSchema = z.string().min(1).max(4_096);
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
    return { ok: true, sessionCreated: true };
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (parsed.data.mode === "recovery") {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      captchaToken: parsed.data.captchaToken,
      ...(siteUrl ? { redirectTo: `${siteUrl}/auth/callback` } : {}),
    });
    if (error) {
      return {
        ok: false,
        error: /captcha/i.test(`${error.code ?? ""} ${error.message}`)
          ? "The security challenge could not be verified. Please try again."
          : "A recovery email could not be requested right now.",
      };
    }
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
  return data.session
    ? { ok: true, sessionCreated: true }
    : {
        ok: true,
        sessionCreated: false,
        notice: "Check your email to confirm your account, then return here to sign in.",
      };
}
