"use client";

import { useState } from "react";
import { ArrowUp, LoaderCircle, Sparkles } from "lucide-react";

export function AiCustomizationBar({
  question,
  placeholder,
  suggestions,
  onApply,
}: {
  question: string;
  placeholder: string;
  suggestions: string[];
  onApply: (instruction: string) => Promise<{
    error?: string;
    message?: string;
  }>;
}) {
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    const request = instruction.trim();
    if (request.length < 3 || pending) return;
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await onApply(request);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMessage(result.message ?? "Changes applied.");
    setInstruction("");
  }

  return (
    <section className="rounded-2xl border border-[#e7c75f] bg-[#fff7dc] p-3.5 sm:p-4">
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
          <Sparkles className="size-3.5" />
        </span>
        <div>
          <h3 className="text-[11px] font-semibold text-[#272536]">{question}</h3>
          <p className="mt-0.5 text-[9px] leading-4 text-slate-500">
            Describe the result normally. FlowMind handles the setup details.
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-end gap-2 rounded-xl border border-[#d9cfbf] bg-[#fffdfa] p-2 shadow-sm focus-within:border-[#d7aa2f] focus-within:ring-4 focus-within:ring-[#f4e5ad]">
        <textarea
          value={instruction}
          onChange={(event) => {
            setInstruction(event.target.value);
            setError(null);
            setMessage(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void apply();
            }
          }}
          rows={2}
          maxLength={2_000}
          disabled={pending}
          placeholder={placeholder}
          className="max-h-28 min-h-11 flex-1 resize-none bg-transparent px-1.5 py-1 text-[11px] leading-5 text-slate-800 outline-none placeholder:text-slate-400 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void apply()}
          disabled={instruction.trim().length < 3 || pending}
          aria-label="Apply changes with AI"
          className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#dfbd4c] bg-[#f1c94b] text-[#272536] transition hover:bg-[#f4d66c] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>

      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={pending}
            onClick={() => {
              setInstruction(suggestion);
              setError(null);
              setMessage(null);
            }}
            className="shrink-0 rounded-full border border-[#e1bd4b] bg-[#fffdfa] px-2.5 py-1 text-[8px] font-medium text-[#7f5d00] transition hover:bg-[#fff0b9] disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>

      <div aria-live="polite" className="mt-2 min-h-4 text-[9px] leading-4">
        {pending && <span className="text-[#7f5d00]">FlowMind is applying your changes…</span>}
        {!pending && error && <span role="alert" className="text-rose-600">{error}</span>}
        {!pending && !error && message && <span className="text-emerald-700">{message}</span>}
      </div>
    </section>
  );
}
