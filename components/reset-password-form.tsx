"use client";

import { useState } from "react";
import { CheckCircle2, LoaderCircle, LockKeyhole } from "lucide-react";

import { updateRecoveredPassword } from "@/app/actions/auth";

export function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await updateRecoveredPassword({ password, confirmation });
      if (!result.ok) {
        setError(result.error);
        setPending(false);
        return;
      }
      window.location.replace("/login?notice=password_updated");
    } catch {
      setError("Your password could not be updated. Please request a new recovery link.");
      setPending(false);
    }
  }

  return (
    <section className="w-full max-w-md rounded-[28px] border border-[#ddd5c9] bg-[#fffdfa] p-7 shadow-sm sm:p-9">
      <span className="flex size-11 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><LockKeyhole className="size-5" /></span>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-slate-950">Choose a new password</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">Use at least 12 characters with uppercase, lowercase, a number, and a symbol.</p>
      <form onSubmit={(event) => void submit(event)} className="mt-7 space-y-4">
        <label className="block text-xs font-semibold text-slate-700">New password
          <input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3.5 text-sm outline-none focus:border-[#d7aa2f] focus:ring-4 focus:ring-[#f4e5ad]" />
        </label>
        <label className="block text-xs font-semibold text-slate-700">Confirm new password
          <input type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3.5 text-sm outline-none focus:border-[#d7aa2f] focus:ring-4 focus:ring-[#f4e5ad]" />
        </label>
        {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs text-rose-700">{error}</p>}
        <button type="submit" disabled={pending} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#dfbd4c] bg-[#f1c94b] text-sm font-semibold text-[#272536] disabled:opacity-60">
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
          {pending ? "Updating password…" : "Update password"}
        </button>
      </form>
    </section>
  );
}
