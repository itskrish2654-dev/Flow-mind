"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Eye,
  FormInput,
  LoaderCircle,
  Plus,
  Save,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

import { AiCustomizationBar } from "@/components/ai-customization-bar";
import {
  PublicFormDefinitionSchema,
  type PublicFormDefinition,
  type PublicFormField,
  type PublicFormFieldType,
} from "@/lib/schemas/workflow";

const FIELD_TYPES: Array<{ value: PublicFormFieldType; label: string }> = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "url", label: "Website URL" },
  { value: "select", label: "Dropdown" },
  { value: "checkbox", label: "Checkbox" },
];

function cloneForm(form: PublicFormDefinition): PublicFormDefinition {
  return {
    ...form,
    fields: form.fields.map((field) => ({
      ...field,
      ...(field.options ? { options: [...field.options] } : {}),
    })),
  };
}

function slugifyKey(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return /^[a-z]/.test(key) ? key : `field_${key}`.slice(0, 50);
}

function uniqueKey(fields: PublicFormField[], preferred: string): string {
  const base = slugifyKey(preferred) || "field";
  let candidate = base;
  let suffix = 2;
  while (fields.some((field) => field.key === candidate)) {
    candidate = `${base.slice(0, 46)}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function PreviewField({ field }: { field: PublicFormField }) {
  const shared =
    "mt-1.5 h-10 w-full rounded-lg border border-[#ddd5c9] bg-[#faf8f4] px-3 text-[10px] text-slate-500";

  if (field.type === "checkbox") {
    return (
      <label className="mt-2 flex items-start gap-2 rounded-lg border border-[#ddd5c9] bg-[#faf8f4] px-3 py-2.5 text-[10px] text-slate-600">
        <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border border-[#d7aa2f] bg-white" />
        <span>{field.label}</span>
      </label>
    );
  }

  return (
    <div>
      <label className="text-[9px] font-semibold text-slate-700">
        {field.label}
        {!field.required && <span className="ml-1 font-normal text-slate-400">Optional</span>}
      </label>
      {field.type === "textarea" ? (
        <div className={`${shared} h-16 py-2`}>{field.placeholder}</div>
      ) : field.type === "select" ? (
        <div className={`${shared} flex items-center justify-between`}>
          <span>{field.placeholder || "Choose an option"}</span>
          <span>⌄</span>
        </div>
      ) : (
        <div className={`${shared} flex items-center`}>{field.placeholder}</div>
      )}
      {field.helpText && <p className="mt-1 text-[8px] leading-3 text-slate-400">{field.helpText}</p>}
    </div>
  );
}

function FormPreview({ form }: { form: PublicFormDefinition }) {
  return (
    <div className="mx-auto w-full max-w-md rounded-[22px] border border-[#ddd5c9] bg-[#fffdfa] p-5 shadow-[0_20px_55px_-38px_rgba(72,61,35,.4)]">
      <div className="-mx-5 -mt-5 mb-5 h-1 rounded-t-[22px] bg-[#f1c94b]" />
      <h3 className="text-lg font-semibold tracking-[-0.03em] text-slate-950">
        {form.title || "Untitled form"}
      </h3>
      {form.description && (
        <p className="mt-2 text-[10px] leading-4 text-slate-500">{form.description}</p>
      )}
      <div className="mt-5 space-y-4">
        {form.fields.map((field) => <PreviewField key={field.key} field={field} />)}
      </div>
      <div className="mt-5 flex h-10 items-center justify-center rounded-lg border border-[#dfbd4c] bg-[#f1c94b] text-[10px] font-semibold text-[#272536]">
        {form.submitButtonLabel || "Submit"}
      </div>
    </div>
  );
}

export function FormBuilder({
  form,
  onSave,
  onAiCustomize,
}: {
  form: PublicFormDefinition;
  onSave: (form: PublicFormDefinition) => Promise<string | null>;
  onAiCustomize: (instruction: string) => Promise<{
    error?: string;
    message?: string;
    form?: PublicFormDefinition;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => cloneForm(form));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fineTune, setFineTune] = useState(false);
  const [undoForm, setUndoForm] = useState<PublicFormDefinition | null>(null);
  const [undoing, setUndoing] = useState(false);

  const selectedField = draft.fields[selectedIndex] ?? draft.fields[0];
  const fieldTypeLabel = useMemo(
    () => new Map(FIELD_TYPES.map((fieldType) => [fieldType.value, fieldType.label])),
    [],
  );

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function openBuilder() {
    setDraft(cloneForm(form));
    setSelectedIndex(0);
    setError(null);
    setSaved(false);
    setFineTune(false);
    setUndoForm(null);
    setOpen(true);
  }

  async function applyAiChange(instruction: string) {
    const previous = cloneForm(draft);
    const result = await onAiCustomize(instruction);
    if (result.error || !result.form) return result;
    setUndoForm(previous);
    setDraft(cloneForm(result.form));
    setSelectedIndex(0);
    setSaved(true);
    return { message: result.message ?? "Your form has been updated." };
  }

  async function undoAiChange() {
    if (!undoForm || undoing) return;
    setUndoing(true);
    const restore = cloneForm(undoForm);
    const restoreError = await onSave(restore);
    setUndoing(false);
    if (restoreError) {
      setError(restoreError);
      return;
    }
    setDraft(restore);
    setUndoForm(null);
    setSaved(true);
  }

  function updateField(patch: Partial<PublicFormField>) {
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((field, index) =>
        index === selectedIndex ? { ...field, ...patch } : field,
      ),
    }));
    setSaved(false);
  }

  function addField(type: PublicFormFieldType = "text") {
    if (draft.fields.length >= 10) return;
    const label = type === "checkbox" ? "I agree" : "New field";
    const nextField: PublicFormField = {
      key: uniqueKey(draft.fields, label),
      label,
      type,
      required: false,
      ...(type === "select" ? { options: ["Option one", "Option two"] } : {}),
    };
    setDraft({ ...draft, fields: [...draft.fields, nextField] });
    setSelectedIndex(draft.fields.length);
    setSaved(false);
  }

  function removeField(index: number) {
    if (draft.fields.length === 1) return;
    const fields = draft.fields.filter((_, fieldIndex) => fieldIndex !== index);
    setDraft({ ...draft, fields });
    setSelectedIndex(Math.max(0, Math.min(index, fields.length - 1)));
    setSaved(false);
  }

  function moveField(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= draft.fields.length) return;
    const fields = [...draft.fields];
    [fields[index], fields[destination]] = [fields[destination], fields[index]];
    setDraft({ ...draft, fields });
    setSelectedIndex(destination);
    setSaved(false);
  }

  async function saveForm() {
    const parsed = PublicFormDefinitionSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the form fields and try again.");
      return;
    }
    if (new Set(parsed.data.fields.map((field) => field.key)).size !== parsed.data.fields.length) {
      setError("Each field must be unique.");
      return;
    }

    setSaving(true);
    setError(null);
    const saveError = await onSave(parsed.data);
    setSaving(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setSaved(true);
    window.setTimeout(() => setOpen(false), 650);
  }

  const aiCustomizationPanel = (
    <>
      <AiCustomizationBar
        question="What should this form collect?"
        placeholder="For example: Make this a client intake form. Ask for their service, budget, deadline, and a detailed project brief."
        suggestions={[
          "Add a required phone number",
          "Turn this into a client intake form",
          "Make the form shorter and friendlier",
        ]}
        onApply={applyAiChange}
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[9px] text-slate-500">AI changes are saved automatically.</p>
        <div className="flex items-center gap-2">
          {undoForm && (
            <button type="button" onClick={() => void undoAiChange()} disabled={undoing} className="flex h-8 items-center gap-1.5 rounded-lg border border-[#ded6ca] px-2.5 text-[9px] font-semibold text-slate-600 hover:bg-[#f8f4ec] disabled:opacity-50">
              {undoing ? <LoaderCircle className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Undo AI change
            </button>
          )}
          <button type="button" onClick={() => setFineTune((current) => !current)} className="flex h-8 items-center gap-1.5 rounded-lg border border-[#ded6ca] px-2.5 text-[9px] font-semibold text-slate-600 hover:border-[#d7aa2f] hover:bg-[#fff7dc]">
            {fineTune ? "Back to AI view" : "Fine tune manually"} <ChevronDown className={`size-3 transition ${fineTune ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      <button
        type="button"
        onClick={openBuilder}
        className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-[#fffdfa] text-[10px] font-semibold text-[#6f5100] transition hover:bg-[#fff0b9]"
      >
        <FormInput className="size-3.5" />
        Customize with AI
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
          <button
            type="button"
            aria-label="Close form builder"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-slate-950/25 backdrop-blur-[2px]"
          />
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="form-builder-title"
            className="relative flex max-h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-[24px] border border-[#ddd5c9] bg-[#fffdfa] shadow-2xl"
          >
            <header className="flex shrink-0 items-center gap-3 border-b border-[#e4ddd2] px-4 py-3 sm:px-5">
              <span className="flex size-9 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
                <FormInput className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="form-builder-title" className="text-sm font-semibold text-[#272536]">Customize hosted form</h2>
                <p className="text-[10px] text-slate-500">Tell FlowMind what you need and review the result.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="flex size-9 items-center justify-center rounded-lg border border-[#ded6ca] text-slate-500 hover:bg-[#f8f4ec]">
                <X className="size-4" />
              </button>
            </header>

            {fineTune ? (
              <>
                <div className="shrink-0 border-b border-[#e4ddd2] bg-[#fffdfa] p-4 sm:p-5">
                  {aiCustomizationPanel}
                </div>
                <div className="grid min-h-0 flex-1 lg:grid-cols-[250px_minmax(300px,1fr)_minmax(320px,.9fr)]">
              <aside className="min-h-0 overflow-y-auto border-b border-[#e4ddd2] bg-[#faf8f4] p-3 lg:border-b-0 lg:border-r">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-slate-400">Fields · {draft.fields.length}/10</p>
                  <button type="button" onClick={() => addField()} disabled={draft.fields.length >= 10} className="flex size-7 items-center justify-center rounded-lg border border-[#d7aa2f] text-[#8a6200] hover:bg-[#fff0b9] disabled:opacity-40" aria-label="Add field">
                    <Plus className="size-3.5" />
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  {draft.fields.map((field, index) => (
                    <div key={field.key} className={`group flex items-center gap-1 rounded-xl border p-1.5 transition ${selectedIndex === index ? "border-[#d7aa2f] bg-[#fff7dc]" : "border-[#e4ddd2] bg-[#fffdfa]"}`}>
                      <button type="button" onClick={() => setSelectedIndex(index)} className="min-w-0 flex-1 px-2 py-1.5 text-left">
                        <span className="block truncate text-[10px] font-semibold text-slate-800">{field.label}</span>
                        <span className="mt-0.5 block truncate text-[8px] text-slate-400">{fieldTypeLabel.get(field.type)}</span>
                      </button>
                      <div className="grid gap-0.5">
                        <button type="button" onClick={() => moveField(index, -1)} disabled={index === 0} aria-label={`Move ${field.label} up`} className="flex size-5 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-25"><ArrowUp className="size-3" /></button>
                        <button type="button" onClick={() => moveField(index, 1)} disabled={index === draft.fields.length - 1} aria-label={`Move ${field.label} down`} className="flex size-5 items-center justify-center rounded text-slate-400 hover:bg-white hover:text-slate-700 disabled:opacity-25"><ArrowDown className="size-3" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </aside>

              <div className="min-h-0 overflow-y-auto border-b border-[#e4ddd2] p-4 lg:border-b-0 lg:border-r sm:p-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="sm:col-span-2 text-[10px] font-semibold text-slate-700">Form title
                    <input value={draft.title} maxLength={120} onChange={(event) => { setDraft((current) => ({ ...current, title: event.target.value })); setSaved(false); }} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f] focus:ring-4 focus:ring-[#f4e5ad]" />
                  </label>
                  <label className="sm:col-span-2 text-[10px] font-semibold text-slate-700">Description
                    <textarea value={draft.description} maxLength={300} rows={2} onChange={(event) => { setDraft((current) => ({ ...current, description: event.target.value })); setSaved(false); }} className="mt-1.5 w-full resize-y rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 py-2 text-[11px] outline-none focus:border-[#d7aa2f] focus:ring-4 focus:ring-[#f4e5ad]" />
                  </label>
                </div>

                {selectedField && (
                  <section className="mt-6 border-t border-[#ece6dc] pt-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-[11px] font-semibold text-slate-900">Selected field</h3>
                        <p className="mt-0.5 text-[9px] text-slate-400">Adjust the label, field type, and validation only if needed.</p>
                      </div>
                      <button type="button" onClick={() => removeField(selectedIndex)} disabled={draft.fields.length === 1} className="flex h-8 items-center gap-1.5 rounded-lg border border-rose-200 px-2.5 text-[9px] font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-35"><Trash2 className="size-3" /> Remove</button>
                    </div>
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <label className="text-[10px] font-semibold text-slate-700">Label
                        <input value={selectedField.label} maxLength={80} onChange={(event) => updateField({ label: event.target.value })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                      </label>
                      <label className="text-[10px] font-semibold text-slate-700">Field type
                        <select value={selectedField.type} onChange={(event) => updateField({ type: event.target.value as PublicFormFieldType, ...(event.target.value === "select" && !selectedField.options ? { options: ["Option one", "Option two"] } : {}) })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]">
                          {FIELD_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                        </select>
                      </label>
                      <label className="text-[10px] font-semibold text-slate-700">Placeholder
                        <input value={selectedField.placeholder ?? ""} maxLength={160} disabled={selectedField.type === "checkbox"} onChange={(event) => updateField({ placeholder: event.target.value || undefined })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f] disabled:opacity-45" />
                      </label>
                      <label className="sm:col-span-2 text-[10px] font-semibold text-slate-700">Help text
                        <input value={selectedField.helpText ?? ""} maxLength={240} onChange={(event) => updateField({ helpText: event.target.value || undefined })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                      </label>
                      {selectedField.type === "select" && (
                        <label className="sm:col-span-2 text-[10px] font-semibold text-slate-700">Dropdown options · one per line
                          <textarea value={(selectedField.options ?? []).join("\n")} rows={4} onChange={(event) => updateField({ options: event.target.value.split(/\r?\n/).map((option) => option.trim()).filter(Boolean).slice(0, 20) })} className="mt-1.5 w-full resize-y rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 py-2 text-[11px] outline-none focus:border-[#d7aa2f]" />
                        </label>
                      )}
                      {["text", "email", "phone", "url", "textarea"].includes(selectedField.type) && (
                        <>
                          <label className="text-[10px] font-semibold text-slate-700">Minimum characters
                            <input type="number" min={0} max={5000} value={selectedField.minLength ?? ""} onChange={(event) => updateField({ minLength: event.target.value ? Number(event.target.value) : undefined })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                          </label>
                          <label className="text-[10px] font-semibold text-slate-700">Maximum characters
                            <input type="number" min={1} max={5000} value={selectedField.maxLength ?? ""} onChange={(event) => updateField({ maxLength: event.target.value ? Number(event.target.value) : undefined })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                          </label>
                        </>
                      )}
                      {selectedField.type === "number" && (
                        <>
                          <label className="text-[10px] font-semibold text-slate-700">Minimum value
                            <input type="number" value={selectedField.min ?? ""} onChange={(event) => updateField({ min: event.target.value ? Number(event.target.value) : undefined })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                          </label>
                          <label className="text-[10px] font-semibold text-slate-700">Maximum value
                            <input type="number" value={selectedField.max ?? ""} onChange={(event) => updateField({ max: event.target.value ? Number(event.target.value) : undefined })} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                          </label>
                        </>
                      )}
                      <label className="sm:col-span-2 flex items-center gap-2 rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 py-2.5 text-[10px] font-semibold text-slate-700">
                        <input type="checkbox" checked={selectedField.required} onChange={(event) => updateField({ required: event.target.checked })} className="size-4 accent-[#d7aa2f]" />
                        Required field
                      </label>
                    </div>
                  </section>
                )}

                <section className="mt-6 border-t border-[#ece6dc] pt-5">
                  <h3 className="text-[11px] font-semibold text-slate-900">Submission experience</h3>
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <label className="text-[10px] font-semibold text-slate-700">Submit button
                      <input value={draft.submitButtonLabel} maxLength={60} onChange={(event) => setDraft((current) => ({ ...current, submitButtonLabel: event.target.value }))} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                    </label>
                    <label className="text-[10px] font-semibold text-slate-700">Success title
                      <input value={draft.successTitle} maxLength={100} onChange={(event) => setDraft((current) => ({ ...current, successTitle: event.target.value }))} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                    </label>
                    <label className="sm:col-span-2 text-[10px] font-semibold text-slate-700">Success message
                      <input value={draft.successMessage} maxLength={240} onChange={(event) => setDraft((current) => ({ ...current, successMessage: event.target.value }))} className="mt-1.5 h-10 w-full rounded-lg border border-[#ded6ca] bg-[#faf8f4] px-3 text-[11px] outline-none focus:border-[#d7aa2f]" />
                    </label>
                  </div>
                </section>
              </div>

              <aside className="min-h-0 overflow-y-auto bg-[#f7f4ee] p-4 sm:p-6">
                <p className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.13em] text-slate-400"><Eye className="size-3.5" /> Live preview</p>
                <div className="mt-4"><FormPreview form={draft} /></div>
                  </aside>
                </div>
              </>
            ) : (
              <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(340px,.88fr)_minmax(460px,1.12fr)]">
                <div className="min-h-0 overflow-y-auto border-b border-[#e4ddd2] bg-[#fffdfa] p-4 sm:p-6 lg:border-b-0 lg:border-r">
                  {aiCustomizationPanel}
                </div>
                <aside className="min-h-0 overflow-y-auto bg-[#f7f4ee] p-5 sm:p-8">
                  <p className="mb-4 flex items-center justify-center gap-2 text-[9px] font-semibold uppercase tracking-[0.13em] text-slate-400"><Eye className="size-3.5" /> Current form preview</p>
                  <FormPreview form={draft} />
                </aside>
              </div>
            )}

            <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 sm:px-5">
              <p className="min-w-0 flex-1 text-[10px] text-slate-500">
                {error ? <span role="alert" className="text-rose-600">{error}</span> : fineTune && selectedField ? fieldTypeLabel.get(selectedField.type) : "Describe another change or close when it looks right."}
              </p>
              <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-lg border border-[#ded6ca] px-3 text-[10px] font-semibold text-slate-600 hover:bg-[#f8f4ec]">Close</button>
              {fineTune && (
                <button type="button" onClick={() => void saveForm()} disabled={saving} className="flex h-9 items-center gap-2 rounded-lg border border-[#d7aa2f] bg-[#f1c94b] px-4 text-[10px] font-semibold text-[#272536] hover:bg-[#f4d66c] disabled:opacity-60">
                  {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
                  {saving ? "Saving…" : saved ? "Saved" : "Save Fine Tuning"}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
