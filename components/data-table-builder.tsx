"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Columns3, LoaderCircle, Save, X } from "lucide-react";

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
}: {
  form: PublicFormDefinition;
  definition: DataTableDefinition;
  onSave: (definition: DataTableDefinition) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [columns, setColumns] = useState<DataTableColumn[]>(definition.columns);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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
    setOpen(true);
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
        <Columns3 className="size-3.5" /> Customize Data Columns
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button type="button" aria-label="Close data table builder" onClick={() => setOpen(false)} className="absolute inset-0 bg-slate-950/25 backdrop-blur-[2px]" />
          <section role="dialog" aria-modal="true" aria-labelledby="data-table-builder-title" className="relative flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[22px] border border-[#ddd5c9] bg-[#fffdfa] shadow-2xl">
            <header className="flex items-center gap-3 border-b border-[#e4ddd2] px-5 py-4">
              <span className="flex size-9 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Columns3 className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <h2 id="data-table-builder-title" className="text-sm font-semibold text-[#272536]">Customize data columns</h2>
                <p className="text-[10px] text-slate-500">Choose up to ten fields and rename how they appear in the execution table.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="flex size-9 items-center justify-center rounded-lg border border-[#ded6ca] text-slate-500 hover:bg-[#f8f4ec]"><X className="size-4" /></button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="grid gap-3 sm:grid-cols-2">
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
                          <span className="mt-0.5 block font-mono text-[8px] text-slate-400">{column.source}.{column.key}</span>
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
              </div>
            </div>

            <footer className="flex items-center gap-3 border-t border-[#e4ddd2] px-5 py-3">
              <p className="min-w-0 flex-1 text-[10px] text-slate-500">{error ? <span role="alert" className="text-rose-600">{error}</span> : `${columns.length}/10 columns selected`}</p>
              <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-lg border border-[#ded6ca] px-3 text-[10px] font-semibold text-slate-600 hover:bg-[#f8f4ec]">Cancel</button>
              <button type="button" onClick={() => void saveColumns()} disabled={saving} className="flex h-9 items-center gap-2 rounded-lg border border-[#d7aa2f] bg-[#f1c94b] px-4 text-[10px] font-semibold text-[#272536] hover:bg-[#f4d66c] disabled:opacity-60">
                {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
                {saving ? "Saving…" : saved ? "Saved" : "Save Columns"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
