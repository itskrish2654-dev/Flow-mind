"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { setCopied(false); }
  }} className="min-h-10 rounded-lg border border-[#ded6ca] px-3 text-xs font-semibold text-slate-700 hover:bg-[#faf8f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b7309]">
    {copied ? "Copied" : "Copy"}
  </button>;
}
