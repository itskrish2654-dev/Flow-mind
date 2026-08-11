"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, LockKeyhole, Mail, Zap } from "lucide-react";

import { authenticateWithPassword } from "@/app/actions/auth";
import { AuthTurnstile } from "@/components/auth-turnstile";

type AuthMode = "login" | "signup" | "recovery";

export function LoginForm({
  nextPath,
  turnstileSiteKey,
}: {
  nextPath: string;
  turnstileSiteKey: string | null;
}) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [challengeReset, setChallengeReset] = useState(0);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<"authenticating" | "opening" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function chooseMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(null);
    setNotice(null);
    setCaptchaToken(null);
    setChallengeError(null);
    setChallengeReset((value) => value + 1);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    if (!captchaToken) {
      setError("Complete the security challenge and try again.");
      return;
    }
    setIsSubmitting(true);
    setProgress("authenticating");
    setError(null);
    setNotice(null);
    let navigationStarted = false;

    try {
      const result = await authenticateWithPassword(
        mode === "recovery"
          ? { mode, email: email.trim(), captchaToken }
          : { mode, email: email.trim(), password, captchaToken },
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.sessionCreated) {
        navigationStarted = true;
        setProgress("opening");
        window.location.replace(nextPath);
      } else {
        setNotice(result.notice ?? "Check your email, then return here to sign in.");
      }
    } catch {
      setError("Authentication is temporarily unavailable. Please try again.");
    } finally {
      if (!navigationStarted) {
        setCaptchaToken(null);
        setChallengeReset((value) => value + 1);
        setIsSubmitting(false);
        setProgress(null);
      }
    }
  }

  const heading = mode === "login"
    ? "Welcome back"
    : mode === "signup"
      ? "Create your workspace"
      : "Recover your account";
  const description = mode === "login"
    ? "Log in to access only your saved automations."
    : mode === "signup"
      ? "Sign up to keep every workflow private and tied to your account."
      : "Enter your email and we’ll send a secure recovery link.";

  return (
    <div className="relative w-full max-w-[420px] overflow-hidden rounded-[28px] border border-[#ddd5c9] bg-[#fffdfa] p-6 shadow-[0_30px_90px_-52px_rgba(72,61,35,.32)] sm:p-8">
      <div className="absolute inset-x-0 top-0 h-1 bg-[#f1c94b]" />
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Zap className="size-[18px] fill-current" /></span>
        <div><p className="text-lg font-bold tracking-[-0.03em] text-slate-950">FlowMind</p><p className="text-[11px] text-slate-600">Your private automation workspace</p></div>
      </div>

      {isSubmitting ? (
        <div className="flex min-h-[420px] flex-col items-center justify-center text-center" role="status" aria-live="polite">
          <div className="relative flex size-24 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-[#f7e7a9]/70" />
            <span className="absolute inset-2 animate-pulse rounded-full bg-[#fff2bd]" />
            <span className="relative flex size-14 items-center justify-center rounded-2xl border border-[#e4c35d] bg-[#f1c94b] text-[#272536] shadow-[0_14px_32px_-18px_rgba(138,98,0,.7)]">
              {progress === "opening" ? <CheckCircle2 className="size-7" /> : <LockKeyhole className="size-6" />}
            </span>
          </div>
          <h1 className="mt-7 text-2xl font-semibold tracking-[-0.035em] text-slate-950">
            {progress === "opening" ? "You’re all set" : mode === "login" ? "Signing you in" : mode === "signup" ? "Creating your workspace" : "Requesting recovery"}
          </h1>
          <p className="mt-2 max-w-[280px] text-sm leading-6 text-slate-500">
            {progress === "opening" ? "Opening your private automation workspace now." : "Securely verifying your request. This usually takes just a few seconds."}
          </p>
          <div className="mt-7 h-1.5 w-56 overflow-hidden rounded-full bg-[#eee9df]"><span className="auth-progress-bar block h-full w-1/2 rounded-full bg-[#d7aa2f]" /></div>
        </div>
      ) : (
        <>
          {mode === "recovery" ? (
            <button type="button" onClick={() => chooseMode("login")} className="mt-7 flex items-center gap-1.5 text-xs font-semibold text-slate-600 transition hover:text-slate-950">
              <ArrowLeft className="size-3.5" /> Back to login
            </button>
          ) : (
            <div className="mt-8 grid grid-cols-2 rounded-xl bg-[#f1ede5] p-1">
              {(["login", "signup"] as const).map((value) => (
                <button key={value} type="button" onClick={() => chooseMode(value)} className={`h-9 rounded-lg text-xs font-semibold transition ${mode === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-700 hover:text-slate-950"}`}>
                  {value === "login" ? "Log in" : "Create account"}
                </button>
              ))}
            </div>
          )}

          <div className="mt-7">
            <h1 className="text-2xl font-semibold tracking-[-0.035em] text-slate-950">{heading}</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
          </div>

          <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="text-xs font-semibold text-slate-700">Email address</label>
              <div className="relative mt-2"><Mail className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" className="h-11 w-full rounded-xl border border-[#ddd5c9] bg-[#faf8f4] pl-10 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-[#cfc5b6] focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]" /></div>
            </div>
            {mode !== "recovery" && (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="password" className="text-xs font-semibold text-slate-700">Password</label>
                  {mode === "login" && <button type="button" onClick={() => chooseMode("recovery")} className="text-[11px] font-semibold text-[#8a6200] hover:text-[#604500]">Forgot password?</button>}
                </div>
                <div className="relative mt-2"><LockKeyhole className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input id="password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" className="h-11 w-full rounded-xl border border-[#ddd5c9] bg-[#faf8f4] pl-10 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-[#cfc5b6] focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]" /></div>
              </div>
            )}

            {turnstileSiteKey ? (
              <AuthTurnstile siteKey={turnstileSiteKey} resetSignal={challengeReset} onToken={setCaptchaToken} onError={setChallengeError} />
            ) : (
              <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-700">Secure sign-in is unavailable because bot protection is not configured.</p>
            )}
            {challengeError && <p role="alert" className="text-xs leading-5 text-rose-700">{challengeError}</p>}
            {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-700">{error}</p>}
            {notice && <p role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-xs leading-5 text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</p>}

            <button type="submit" disabled={!turnstileSiteKey || !captchaToken} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#dfbd4c] bg-[#f1c94b] text-sm font-semibold text-[#272536] shadow-[0_10px_28px_-18px_rgba(138,98,0,.65)] transition hover:bg-[#f4d66c] disabled:cursor-not-allowed disabled:opacity-50">
              <ArrowRight className="size-4" />
              {mode === "login" ? "Log in securely" : mode === "signup" ? "Create account" : "Send recovery link"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
