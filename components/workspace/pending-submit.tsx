"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

export function PendingSubmit({ children, busyText, className }: { children: ReactNode; busyText: string; className: string }) {
  const { pending } = useFormStatus();
  return <div><button type="submit" disabled={pending} aria-disabled={pending} className={className}>{pending ? "Preparing draft…" : children}</button>
    {pending && <p role="status" aria-live="polite" className="mt-3 text-sm leading-6 text-slate-600">{busyText}</p>}
  </div>;
}
