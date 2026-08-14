"use client";

import { useState } from "react";
import { Download, LoaderCircle, LogOut, ShieldAlert, Trash2 } from "lucide-react";

import { deleteOwnAccount } from "@/app/actions/account";
import { AuthTurnstile } from "@/components/auth-turnstile";
import { createClient } from "@/lib/supabase/client";

function clearCrazyLoopsStorage() {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("flowmind:")) window.localStorage.removeItem(key);
  }
}

export function AccountControls({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [showDelete, setShowDelete] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"logout" | "delete" | null>(null);

  async function logout() {
    if (pending) return;
    setPending("logout");
    const { error: logoutError } = await createClient().auth.signOut({ scope: "local" });
    if (logoutError) {
      setError("We couldn't log you out. Please try again.");
      setPending(null);
      return;
    }
    clearCrazyLoopsStorage();
    window.location.replace("/login");
  }

  async function startPasswordRecovery() {
    if (pending) return;
    setPending("logout");
    const { error: logoutError } = await createClient().auth.signOut({ scope: "local" });
    if (logoutError) {
      setError("We couldn't open password recovery. Please try again.");
      setPending(null);
      return;
    }
    clearCrazyLoopsStorage();
    window.location.replace("/login?recover=1");
  }

  async function deleteAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !captchaToken) return;
    setPending("delete");
    setError(null);
    const result = await deleteOwnAccount({ confirmation, password, captchaToken });
    if (!result.ok) {
      setError(result.error);
      setCaptchaToken(null);
      setResetSignal((value) => value + 1);
      setPending(null);
      return;
    }
    clearCrazyLoopsStorage();
    window.location.replace("/login?notice=account_deleted");
  }

  return (
    <div className="space-y-5">
      <section id="session" className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Your data</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Download a bounded JSON archive of your workflows, versions, execution history, document metadata, usage, and credential metadata. Secret values are excluded.</p>
        <a href="/settings/export" className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-[#d8caa8] px-4 text-xs font-semibold text-slate-800 hover:bg-[#fff8e3]"><Download className="size-4" />Download account export</a>
        <p className="mt-3 text-[11px] leading-5 text-slate-500">Safety limits: 250 workflows, 5,000 versions, 5,000 executions, and 25,000 step records. If exceeded, export stops with an error and does not silently omit data.</p>
      </section>

      <section className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Session and password</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">To change your password, use the recovery link on the login screen. Logging out ends this browser session.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => void startPasswordRecovery()} disabled={Boolean(pending)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#d8caa8] px-4 text-xs font-semibold text-slate-800 hover:bg-[#fff8e3] disabled:opacity-60"><ShieldAlert className="size-4" />Change password</button>
          <button type="button" onClick={() => void logout()} disabled={Boolean(pending)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#d8caa8] px-4 text-xs font-semibold text-slate-800 hover:bg-[#fff8e3] disabled:opacity-60">{pending === "logout" ? <LoaderCircle className="size-4 animate-spin" /> : <LogOut className="size-4" />}Log out</button>
        </div>
      </section>

      <section className="rounded-2xl border border-rose-200 bg-rose-50/40 p-5 sm:p-6">
        <div className="flex gap-3"><ShieldAlert className="mt-0.5 size-5 shrink-0 text-rose-600" /><div><h2 className="text-base font-semibold text-slate-950">Delete account</h2><p className="mt-2 text-sm leading-6 text-slate-600">Permanently removes your workflows, versions, executions, credentials, generated documents, document metadata, usage records, and Auth identity. Public forms are disabled before cleanup starts. This cannot be undone.</p></div></div>
        {!showDelete ? (
          <button type="button" onClick={() => setShowDelete(true)} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl border border-rose-300 px-4 text-xs font-semibold text-rose-700 hover:bg-rose-50"><Trash2 className="size-4" />Start account deletion</button>
        ) : (
          <form onSubmit={(event) => void deleteAccount(event)} className="mt-5 max-w-lg space-y-4 rounded-xl border border-rose-200 bg-white p-4">
            <label className="block text-xs font-semibold text-slate-700">Type DELETE MY ACCOUNT
              <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required className="mt-2 h-11 w-full rounded-xl border border-[#ddd5c9] px-3.5 text-sm outline-none focus:border-rose-400 focus:ring-4 focus:ring-rose-100" />
            </label>
            <label className="block text-xs font-semibold text-slate-700">Current password
              <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required className="mt-2 h-11 w-full rounded-xl border border-[#ddd5c9] px-3.5 text-sm outline-none focus:border-rose-400 focus:ring-4 focus:ring-rose-100" />
            </label>
            {turnstileSiteKey ? <AuthTurnstile siteKey={turnstileSiteKey} resetSignal={resetSignal} onToken={setCaptchaToken} onError={(message) => setError(message)} helperText="Required to confirm this destructive request." /> : <p role="alert" className="text-xs text-rose-700">Account deletion is unavailable because bot protection is not configured.</p>}
            {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={pending === "delete" || !captchaToken || confirmation !== "DELETE MY ACCOUNT"} className="inline-flex h-10 items-center gap-2 rounded-xl bg-rose-600 px-4 text-xs font-semibold text-white disabled:opacity-50">{pending === "delete" ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{pending === "delete" ? "Deleting safely…" : "Permanently delete account"}</button>
              <button type="button" onClick={() => { setShowDelete(false); setError(null); }} disabled={pending === "delete"} className="h-10 rounded-xl border border-[#ddd5c9] px-4 text-xs font-semibold">Cancel</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
