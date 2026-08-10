"use client";

import { useActionState } from "react";
import { CheckCircle2, LoaderCircle, LockKeyhole, Send, Zap } from "lucide-react";

import { submitPublicWorkflow } from "@/app/f/[projectId]/actions";
import type { PublicFormSubmissionState } from "@/lib/public-form";
import type { PublicFormDefinition } from "@/lib/schemas/workflow";

const initialState: PublicFormSubmissionState = { status: "idle", message: "" };

export function PublicWorkflowForm({
  projectId,
  form,
}: {
  projectId: string;
  form: PublicFormDefinition;
}) {
  const action = submitPublicWorkflow.bind(null, projectId);
  const [state, formAction, pending] = useActionState(action, initialState);

  if (state.status === "success") {
    return (
      <section className="relative w-full max-w-xl overflow-hidden rounded-[28px] border border-[#ddd5c9] bg-[#fffdfa] p-8 text-center shadow-[0_30px_90px_-52px_rgba(72,61,35,.32)] sm:p-12">
        <div className="absolute inset-x-0 top-0 h-1 bg-[#f1c94b]" />
        <div className="mb-8 flex items-center justify-center gap-2 text-[11px] font-semibold text-[#6f685d]">
          <span className="flex size-6 items-center justify-center rounded-lg border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Zap className="size-3.5 fill-current" /></span>
          FlowMind secure automation
        </div>
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="size-8" />
        </span>
        <h1 className="mt-6 text-2xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-3xl">
          {form.successTitle}
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500">
          {state.message || form.successMessage}
        </p>
        <p className="mt-8 text-[11px] text-slate-500">You can safely close this page.</p>
      </section>
    );
  }

  return (
    <section className="relative w-full max-w-xl overflow-hidden rounded-[28px] border border-[#ddd5c9] bg-[#fffdfa] p-6 shadow-[0_30px_90px_-52px_rgba(72,61,35,.32)] sm:p-9">
      <div className="absolute inset-x-0 top-0 h-1 bg-[#f1c94b]" />
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
            <Zap className="size-[18px] fill-current" />
          </span>
          <div>
            <p className="text-base font-bold tracking-[-0.03em] text-[#272536]">FlowMind</p>
            <p className="text-[10px] text-slate-500">Hosted automation form</p>
          </div>
        </div>
        <span className="hidden items-center gap-1.5 rounded-full border border-[#e3dbcf] bg-[#faf7f1] px-2.5 py-1 text-[9px] font-semibold text-[#6f685d] sm:flex">
          <LockKeyhole className="size-3 text-[#9a7007]" /> Private &amp; secure
        </span>
      </div>

      <div className="mt-7 border-t border-[#ece6dc] pt-7">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-3xl">
          {form.title}
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-500">{form.description}</p>
      </div>

      <form action={formAction} className="mt-8 space-y-5">
        <div className="absolute -left-[9999px]" aria-hidden="true">
          <label htmlFor="company_website">Company website</label>
          <input id="company_website" name="company_website" tabIndex={-1} autoComplete="off" />
        </div>

        {form.fields.map((field) => (
          <div key={field.key}>
            {field.type === "checkbox" ? (
              <label htmlFor={field.key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3.5 py-3 text-sm text-slate-700 transition hover:border-[#cfc5b6]">
                <input
                  id={field.key}
                  name={field.key}
                  type="checkbox"
                  value="true"
                  required={field.required}
                  className="mt-0.5 size-4 shrink-0 accent-[#d7aa2f]"
                />
                <span>
                  <span className="font-semibold">{field.label}</span>
                  {!field.required && <span className="ml-1 text-xs font-normal text-slate-500">Optional</span>}
                  {field.helpText && <span className="mt-1 block text-xs leading-5 text-slate-500">{field.helpText}</span>}
                </span>
              </label>
            ) : (
              <>
                <label htmlFor={field.key} className="text-xs font-semibold text-slate-700">
                  {field.label}
                  {!field.required && <span className="ml-1 font-normal text-slate-500">Optional</span>}
                </label>
                {field.type === "textarea" ? (
              <textarea
                id={field.key}
                name={field.key}
                required={field.required}
                minLength={field.minLength}
                maxLength={field.maxLength ?? 5_000}
                rows={5}
                placeholder={field.placeholder}
                className="mt-2 min-h-28 w-full resize-y rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-[#cfc5b6] focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
              />
                ) : field.type === "select" ? (
                  <select
                    id={field.key}
                    name={field.key}
                    required={field.required}
                    defaultValue=""
                    className="mt-2 h-12 w-full rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3.5 text-sm text-slate-900 outline-none transition hover:border-[#cfc5b6] focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
                  >
                    <option value="" disabled>{field.placeholder || "Choose an option"}</option>
                    {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
              <input
                id={field.key}
                name={field.key}
                type={field.type === "phone" ? "tel" : field.type}
                required={field.required}
                minLength={field.minLength}
                maxLength={field.maxLength ?? 5_000}
                min={field.type === "number" ? field.min : undefined}
                max={field.type === "number" ? field.max : undefined}
                inputMode={field.type === "phone" ? "tel" : field.type === "number" ? "decimal" : undefined}
                autoComplete={field.type === "email" ? "email" : field.key === "name" ? "name" : undefined}
                placeholder={field.placeholder}
                className="mt-2 h-12 w-full rounded-xl border border-[#ddd5c9] bg-[#faf8f4] px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 hover:border-[#cfc5b6] focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
              />
                )}
                {field.helpText && <p className="mt-1.5 text-xs leading-5 text-slate-500">{field.helpText}</p>}
              </>
            )}
          </div>
        ))}

        {state.status === "error" && (
          <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-700">
            {state.message}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-[#dfbd4c] bg-[#f1c94b] text-sm font-semibold text-[#272536] shadow-[0_10px_28px_-18px_rgba(138,98,0,.65)] transition hover:bg-[#f4d66c] disabled:cursor-wait disabled:opacity-70"
        >
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
          {pending ? "Processing your submission…" : form.submitButtonLabel}
        </button>
        <p className="flex items-center justify-center gap-1.5 text-center text-[10px] text-slate-500">
          <LockKeyhole className="size-3 text-[#9a7007]" /> Sent securely to this automation
        </p>
      </form>
    </section>
  );
}
