"use client";

import { useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, LockKeyhole, Mail, Zap } from "lucide-react";

import { createClient } from "@/lib/supabase/client";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState<"authenticating" | "opening" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setProgress("authenticating");
    setError(null);
    setNotice(null);
    let navigationStarted = false;

    try {
      if (mode === "login") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (signInError) {
          setError(signInError.message);
          return;
        }
        navigationStarted = true;
        setProgress("opening");
        window.location.replace(nextPath);
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      });
      if (signUpError) {
        setError(signUpError.message);
        return;
      }
      if (data.session) {
        navigationStarted = true;
        setProgress("opening");
        window.location.replace(nextPath);
      } else {
        setNotice("Check your email to confirm your account, then return here to sign in.");
      }
    } catch {
      setError("Authentication is temporarily unavailable. Please try again.");
    } finally {
      if (!navigationStarted) {
        setIsSubmitting(false);
        setProgress(null);
      }
    }
  }

  return (
    <div className="w-full max-w-[420px] rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_28px_90px_-45px_rgba(30,41,59,.35)] sm:p-8">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-200"><Zap className="size-[18px] fill-current" /></span>
        <div><p className="text-lg font-bold tracking-[-0.03em] text-slate-950">FlowMind</p><p className="text-[11px] text-slate-600">Your private automation workspace</p></div>
      </div>

      {isSubmitting ? (
        <div
          className="flex min-h-[360px] flex-col items-center justify-center text-center"
          role="status"
          aria-live="polite"
        >
          <div className="relative flex size-24 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-indigo-100/70" />
            <span className="absolute inset-2 animate-pulse rounded-full bg-gradient-to-br from-indigo-100 to-violet-100" />
            <span className="relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-xl shadow-indigo-200">
              {progress === "opening" ? (
                <CheckCircle2 className="size-7" />
              ) : (
                <LockKeyhole className="size-6" />
              )}
            </span>
          </div>

          <h1 className="mt-7 text-2xl font-semibold tracking-[-0.035em] text-slate-950">
            {progress === "opening"
              ? "You’re all set"
              : mode === "login"
                ? "Signing you in"
                : "Creating your workspace"}
          </h1>
          <p className="mt-2 max-w-[280px] text-sm leading-6 text-slate-500">
            {progress === "opening"
              ? "Opening your private automation workspace now."
              : "Securely checking your account. This usually takes just a few seconds."}
          </p>

          <div className="mt-7 h-1.5 w-56 overflow-hidden rounded-full bg-slate-100">
            <span className="auth-progress-bar block h-full w-1/2 rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500" />
          </div>
          <div className="mt-5 flex items-center gap-1.5" aria-hidden="true">
            {[0, 1, 2].map((delay) => (
              <span
                key={delay}
                className="size-1.5 animate-bounce rounded-full bg-indigo-400"
                style={{ animationDelay: `${delay * 140}ms` }}
              />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 rounded-xl bg-slate-100 p-1">
            {(["login", "signup"] as const).map((value) => (
              <button key={value} type="button" onClick={() => { setMode(value); setError(null); setNotice(null); }} className={`h-9 rounded-lg text-xs font-semibold transition ${mode === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-700 hover:text-slate-950"}`}>
                {value === "login" ? "Log in" : "Create account"}
              </button>
            ))}
          </div>

          <div className="mt-7">
            <h1 className="text-2xl font-semibold tracking-[-0.035em] text-slate-950">{mode === "login" ? "Welcome back" : "Create your workspace"}</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">{mode === "login" ? "Log in to access only your saved automations." : "Sign up to keep every workflow private and tied to your account."}</p>
          </div>

          <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="text-xs font-semibold text-slate-700">Email address</label>
              <div className="relative mt-2"><Mail className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input id="email" name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-10 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50" /></div>
            </div>
            <div>
              <label htmlFor="password" className="text-xs font-semibold text-slate-700">Password</label>
              <div className="relative mt-2"><LockKeyhole className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input id="password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-10 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50" /></div>
            </div>

            {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-700">{error}</p>}
            {notice && <p role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-xs leading-5 text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</p>}

            <button type="submit" className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition hover:brightness-110">
              <ArrowRight className="size-4" />
              {mode === "login" ? "Log in securely" : "Create account"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
