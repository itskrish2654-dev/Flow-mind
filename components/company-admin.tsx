"use client";

import { useActionState, useState } from "react";
import { Check, Clipboard, ShieldCheck, UserMinus, Users } from "lucide-react";

import {
  changeCompanyMemberRoleAction,
  createCompanyInvitationAction,
  removeCompanyMemberAction,
  renameCompanyAction,
  revokeCompanyInvitationAction,
  type CompanyActionState,
} from "@/app/actions/company";
import type { CompanyInvitation, CompanyMember } from "@/lib/company";

type MutationAction = (state: CompanyActionState, formData: FormData) => Promise<CompanyActionState>;

function Status({ state }: { state: CompanyActionState }) {
  if (!state.message) return null;
  return <p role={state.ok ? "status" : "alert"} className={`mt-3 text-xs ${state.ok ? "text-emerald-700" : "text-rose-700"}`}>{state.message}</p>;
}

function MutationForm({ action, label, danger = false, children }: { action: MutationAction; label: string; danger?: boolean; children: React.ReactNode }) {
  const [state, formAction, pending] = useActionState(action, { ok: false } satisfies CompanyActionState);
  return <form action={formAction} className="flex flex-wrap items-center gap-2">{children}<button type="submit" disabled={pending} className={`min-h-9 rounded-lg border px-3 text-xs font-semibold disabled:opacity-60 ${danger ? "border-rose-200 text-rose-700 hover:bg-rose-50" : "border-[#ddd5c9] text-slate-700 hover:border-[#c7b986]"}`}>{pending ? "Saving…" : label}</button>{state.message ? <span role={state.ok ? "status" : "alert"} className={`text-xs ${state.ok ? "text-emerald-700" : "text-rose-700"}`}>{state.message}</span> : null}</form>;
}

export function CompanyAdmin({ workspaceName, currentRole, members, invitations }: { workspaceName: string; currentRole: "owner" | "admin"; members: CompanyMember[]; invitations: CompanyInvitation[] }) {
  const [copied, setCopied] = useState(false);
  const [renameState, renameAction, renaming] = useActionState(renameCompanyAction, { ok: false } satisfies CompanyActionState);
  const [inviteState, inviteAction, inviting] = useActionState(createCompanyInvitationAction, { ok: false } satisfies CompanyActionState);
  async function copyInvite() {
    if (!inviteState.inviteUrl) return;
    await navigator.clipboard.writeText(inviteState.inviteUrl);
    setCopied(true);
  }
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6">
        <div className="flex items-start gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-[#fff2bd] text-[#8a6200]"><ShieldCheck className="size-5" /></span><div><h2 className="font-semibold text-slate-950">Company details</h2><p className="mt-1 text-xs text-slate-500">You are an {currentRole} in this company workspace.</p></div></div>
        <form action={renameAction} className="mt-5 flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="company-name">Company name</label><input id="company-name" name="name" required maxLength={120} defaultValue={workspaceName} className="min-h-11 flex-1 rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3 text-sm outline-none focus:border-[#d7aa2f] focus:ring-4 focus:ring-[#f4e5ad]" />
          <button type="submit" disabled={renaming} className="min-h-11 rounded-xl bg-[#272536] px-5 text-sm font-semibold text-white disabled:opacity-60">{renaming ? "Saving…" : "Save name"}</button>
        </form><Status state={renameState} />
      </section>

      <section className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6">
        <h2 className="flex items-center gap-2 font-semibold text-slate-950"><Users className="size-5 text-[#8a6200]" />Invite teammates</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Create a secure, single-use link and share it directly with the intended teammate.</p>
        <form action={inviteAction} className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px_auto]">
          <label className="sr-only" htmlFor="invite-email">Work email</label><input id="invite-email" name="email" type="email" required placeholder="teammate@company.com" className="min-h-11 rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3 text-sm outline-none focus:border-[#d7aa2f] focus:ring-4 focus:ring-[#f4e5ad]" />
          <label className="sr-only" htmlFor="invite-role">Role</label><select id="invite-role" name="role" defaultValue="member" className="min-h-11 rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3 text-sm"><option value="member">Member</option>{currentRole === "owner" && <option value="admin">Admin</option>}</select>
          <button type="submit" disabled={inviting} className="min-h-11 rounded-xl bg-[#f1c94b] px-5 text-sm font-semibold text-[#272536] disabled:opacity-60">{inviting ? "Creating…" : "Create invite"}</button>
        </form><Status state={inviteState} />
        {inviteState.inviteUrl && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-xs font-semibold text-emerald-900">Secure invitation link — available once</p><div className="mt-2 flex gap-2"><input readOnly aria-label="Invitation link" value={inviteState.inviteUrl} className="min-w-0 flex-1 rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs text-slate-700" /><button type="button" onClick={() => void copyInvite()} className="flex items-center gap-1 rounded-lg bg-emerald-700 px-3 text-xs font-semibold text-white">{copied ? <Check className="size-3.5" /> : <Clipboard className="size-3.5" />}{copied ? "Copied" : "Copy"}</button></div></div>}
      </section>

      <section className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6">
        <h2 className="font-semibold text-slate-950">Members</h2><p className="mt-1 text-xs text-slate-500">{members.length} active {members.length === 1 ? "member" : "members"}</p>
        <div className="mt-4 divide-y divide-[#eee8df]">
          {members.map((member) => {
            const canEditRole = currentRole === "owner" && member.role !== "owner" && !member.currentUser;
            const canRemove = !member.currentUser && member.role !== "owner" && (currentRole === "owner" || member.role === "member");
            return <div key={member.userId} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{member.displayName ?? member.email}{member.currentUser ? " (you)" : ""}</p><p className="truncate text-xs text-slate-500">{member.email}</p></div><span className="w-fit rounded-full bg-[#f2eee7] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-600">{member.role}</span><div className="flex flex-wrap gap-2">{canEditRole && <MutationForm action={changeCompanyMemberRoleAction} label="Update"><input type="hidden" name="userId" value={member.userId} /><select name="role" defaultValue={member.role} aria-label={`Role for ${member.email}`} className="min-h-9 rounded-lg border border-[#ddd5c9] bg-white px-2 text-xs"><option value="member">Member</option><option value="admin">Admin</option></select></MutationForm>}{canRemove && <MutationForm action={removeCompanyMemberAction} label="Remove" danger><input type="hidden" name="userId" value={member.userId} /><UserMinus className="size-3.5 text-rose-700" /></MutationForm>}</div></div>;
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 sm:p-6">
        <h2 className="font-semibold text-slate-950">Invitations</h2>
        <div className="mt-4 space-y-3">{invitations.length === 0 ? <p className="rounded-xl bg-[#faf8f4] p-4 text-sm text-slate-500">No invitations yet.</p> : invitations.map((invite) => <div key={invite.id} className="flex flex-col gap-3 rounded-xl border border-[#eee8df] p-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{invite.email}</p><p className="mt-1 text-xs text-slate-500">{invite.intendedRole} · {invite.status} · expires {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(invite.expiresAt))}</p></div>{invite.status === "pending" && (currentRole === "owner" || invite.intendedRole === "member") && <MutationForm action={revokeCompanyInvitationAction} label="Revoke" danger><input type="hidden" name="invitationId" value={invite.id} /></MutationForm>}</div>)}</div>
      </section>
    </div>
  );
}
