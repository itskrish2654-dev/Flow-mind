"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Columns3,
  LoaderCircle,
  RotateCcw,
  Save,
  X,
} from "lucide-react";

import { AiCustomizationBar } from "@/components/ai-customization-bar";
import { AccessibleDialog } from "@/components/accessible-dialog";
import type {
  DataTableColumn,
  DataTableDefinition,
  PublicFormDefinition,
} from "@/lib/schemas/workflow";
import { availableDataTableColumns } from "@/lib/workflow-customization";

export function DataTableBuilder({
  form,
  definition,
  onSave,
  onAiCustomize,
}: {
  form: PublicFormDefinition;
  definition: DataTableDefinition;
  onSave: (definition: DataTableDefinition) => Promise<string | null>;
  onAiCustomize: (instruction: string) => Promise<{
    error?: string;
    message?: string;
    definition?: DataTableDefinition;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<DataTableColumn[]>(definition.columns);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fineTune, setFineTune] = useState(false);
  const [undoDefinition, setUndoDefinition] = useState<DataTableDefinition | null>(null);
  const [undoing, setUndoing] = useState(false);
  const available = useMemo(() => availableDataTableColumns(form), [form]);

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
    setColumns(definition.columns.map((column) => ({ ...column })));
    setError(null);
    setSaved(false);
    setFineTune(false);
    setUndoDefinition(null);
    setOpen(true);
  }

  async function applyAiChange(instruction: string) {
    const previous = { columns: columns.map((column) => ({ ...column })) };
    const result = await onAiCustomize(instruction);
    if (result.error || !result.definition) return result;
    setUndoDefinition(previous);
    setColumns(result.definition.columns.map((column) => ({ ...column })));
    setSaved(true);
    return { message: result.message ?? "Your data table has been updated." };
  }

  async function undoAiChange() {
    if (!undoDefinition || undoing) return;
    setUndoing(true);
    const restore = {
      columns: undoDefinition.columns.map((column) => ({ ...column })),
    };
    const restoreError = await onSave(restore);
    setUndoing(false);
    if (restoreError) {
      setError(restoreError);
      return;
    }
    setColumns(restore.columns);
    setUndoDefinition(null);
    setSaved(true);
  }

  function isSelected(column: DataTableColumn) {
    return columns.some(
      (selected) => selected.key === column.key && selected.source === column.source,
    );
  }

  function toggleColumn(column: DataTableColumn) {
    setColumns((current) => {
      const selected = current.some(
        (item) => item.key === column.key && item.source === column.source,
      );
      if (selected) {
        return current.filter(
          (item) => item.key !== column.key || item.source !== column.source,
        );
      }
      if (current.length >= 10) return current;
      return [...current, column];
    });
    setSaved(false);
  }

  function renameColumn(column: DataTableColumn, label: string) {
    setColumns((current) =>
      current.map((item) =>
        item.key === column.key && item.source === column.source
          ? { ...item, label }
          : item,
      ),
    );
    setSaved(false);
  }

  async function saveColumns() {
    if (columns.length === 0) {
      setError("Choose at least one column for the data table.");
      return;
    }
    if (columns.some((column) => !column.label.trim())) {
      setError("Every selected column needs a label.");
      return;
    }
    setSaving(true);
    setError(null);
    const saveError = await onSave({ columns });
    setSaving(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setSaved(true);
    window.setTimeout(() => setOpen(false), 650);
  }

  return (
    <>
      <button
        type="button"
        onClick={openBuilder}
        className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#d9cfbf] bg-white text-[10px] font-semibold text-[#272536] transition hover:border-[#d7aa2f] hover:bg-[#fff7dc]"
      >
        <Columns3 className="size-3.5" /> Customize Data with AI
      </button>

      <AccessibleDialog open={open} onOpenChange={setOpen} title="Customize data columns" description="Choose and rename execution data columns." showClose={false} contentClassName="max-w-2xl">
          <section className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-[22px] bg-[#fffdfa]">
            <header className="flex items-center gap-3 border-b border-[#e4ddd2] px-5 py-4">
              <span className="flex size-9 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Columns3 className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <h2 id="data-table-builder-title" className="text-sm font-semibold text-[#272536]">Customize data columns</h2>
                <p className="text-[10px] text-slate-500">Tell FlowMind what should appear and it will arrange the table.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="flex size-9 items-center justify-center rounded-lg border border-[#ded6ca] text-slate-500 hover:bg-[#f8f4ec]"><X className="size-4" /></button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <AiCustomizationBar
                question="What data do you want to see?"
                placeholder="For example: Show the customer name, email, selected service, AI result, and PDF link. Rename AI result to Recommendation."
                suggestions={[
                  "Show only contact details and AI result",
                  "Add the PDF download column",
                  "Make this a simple lead sheet",
                ]}
                onApply={applyAiChange}
              />

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[9px] text-slate-500">Current table · {columns.length} columns</p>
                <div className="flex items-center gap-2">
                  {undoDefinition && (
                    <button type="button" onClick={() => void undoAiChange()} disabled={undoing} className="flex h-8 items-center gap-1.5 rounded-lg border border-[#ded6ca] px-2.5 text-[9px] font-semibold text-slate-600 hover:bg-[#f8f4ec] disabled:opacity-50">
                      {undoing ? <LoaderCircle className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Undo AI change
                    </button>
                  )}
                  <button type="button" onClick={() => setFineTune((current) => !current)} className="flex h-8 items-center gap-1.5 rounded-lg border border-[#ded6ca] px-2.5 text-[9px] font-semibold text-slate-600 hover:border-[#d7aa2f] hover:bg-[#fff7dc]">
                    Fine tune manually <ChevronDown className={`size-3 transition ${fineTune ? "rotate-180" : ""}`} />
                  </button>
                </div>
              </div>

              {!fineTune && (
                <div className="mt-4 flex flex-wrap gap-2 rounded-xl border border-[#e4ddd2] bg-[#faf8f4] p-4">
                  {columns.map((column) => (
                    <span key={`${column.source}-${column.key}`} className="rounded-full border border-[#e7c75f] bg-[#fff7dc] px-3 py-1.5 text-[9px] font-semibold text-[#7f5d00]">
                      {column.label}
                    </span>
                  ))}
                </div>
              )}

              {fineTune && <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {available.map((column) => {
                  const selected = columns.find(
                    (item) => item.key === column.key && item.source === column.source,
                  );
                  return (
                    <div key={`${column.source}-${column.key}`} className={`rounded-xl border p-3 transition ${selected ? "border-[#d7aa2f] bg-[#fff7dc]" : "border-[#e4ddd2] bg-[#faf8f4]"}`}>
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input type="checkbox" checked={isSelected(column)} onChange={() => toggleColumn(column)} className="mt-0.5 size-4 accent-[#d7aa2f]" />
                        <span className="min-w-0">
                          <span className="block text-[10px] font-semibold text-slate-800">{column.label}</span>
                          <span className="mt-0.5 block text-[8px] text-slate-400">{column.source === "input" ? "Form answer" : "Generated result"}</span>
                        </span>
                      </label>
                      {selected && (
                        <label className="mt-3 block text-[9px] font-semibold text-slate-500">Column label
                          <input value={selected.label} maxLength={80} onChange={(event) => renameColumn(selected, event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[#ded6ca] bg-white px-2.5 text-[10px] text-slate-800 outline-none focus:border-[#d7aa2f]" />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>}
            </div>

            <footer className="flex items-center gap-3 border-t border-[#e4ddd2] px-5 py-3">
              <p className="min-w-0 flex-1 text-[10px] text-slate-500">{error ? <span role="alert" className="text-rose-600">{error}</span> : `${columns.length}/10 columns selected`}</p>
              <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-lg border border-[#ded6ca] px-3 text-[10px] font-semibold text-slate-600 hover:bg-[#f8f4ec]">Close</button>
              {fineTune && (
                <button type="button" onClick={() => void saveColumns()} disabled={saving} className="flex h-9 items-center gap-2 rounded-lg border border-[#d7aa2f] bg-[#f1c94b] px-4 text-[10px] font-semibold text-[#272536] hover:bg-[#f4d66c] disabled:opacity-60">
                  {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
                  {saving ? "Saving…" : saved ? "Saved" : "Save Fine Tuning"}
                </button>
              )}
            </footer>
          </section>
      </AccessibleDialog>
    </>
  );
}
