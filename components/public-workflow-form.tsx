"use client";

import { useActionState } from "react";
import { CheckCircle2, LoaderCircle, Send, Zap } from "lucide-react";

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
      <section className="w-full max-w-xl rounded-[30px] border border-emerald-200 bg-white p-8 text-center shadow-[0_28px_90px_-45px_rgba(30,41,59,.35)] sm:p-12">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="size-8" />
        </span>
        <h1 className="mt-6 text-2xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-3xl">
          Thank you!
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500">
          Your submission has been processed.
        </p>
        <p className="mt-8 text-[11px] text-slate-400">Powered by FlowMind</p>
      </section>
    );
  }

  return (
    <section className="w-full max-w-xl rounded-[30px] border border-slate-200 bg-white p-6 shadow-[0_28px_90px_-45px_rgba(30,41,59,.35)] sm:p-9">
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-200">
          <Zap className="size-5 fill-current" />
        </span>
        <div>
          <p className="text-lg font-bold tracking-[-0.03em] text-slate-950">FlowMind</p>
          <p className="text-[11px] text-slate-500">Secure hosted form</p>
        </div>
      </div>

      <div className="mt-8">
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
            <label htmlFor={field.key} className="text-xs font-semibold text-slate-700">
              {field.label}
              {!field.required && <span className="ml-1 font-normal text-slate-500">Optional</span>}
            </label>
            {field.type === "textarea" ? (
              <textarea
                id={field.key}
                name={field.key}
                required={field.required}
                maxLength={5_000}
                rows={5}
                placeholder={field.placeholder}
                className="mt-2 min-h-28 w-full resize-y rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50"
              />
            ) : (
              <input
                id={field.key}
                name={field.key}
                type={field.type}
                required={field.required}
                maxLength={5_000}
                autoComplete={field.type === "email" ? "email" : field.key === "name" ? "name" : undefined}
                placeholder={field.placeholder}
                className="mt-2 h-12 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50"
              />
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
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition hover:brightness-110 disabled:cursor-wait disabled:opacity-70"
        >
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
          {pending ? "Processing your submission…" : "Submit"}
        </button>
      </form>
    </section>
  );
}
