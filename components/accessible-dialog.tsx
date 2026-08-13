"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function AccessibleDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = "center",
  showClose = true,
  contentClassName = "",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  side?: "center" | "left" | "right" | "bottom";
  showClose?: boolean;
  contentClassName?: string;
}) {
  const position = side === "left"
    ? "inset-y-0 left-0 h-full w-[min(90vw,360px)]"
    : side === "right"
      ? "inset-y-0 right-0 h-full w-[min(94vw,420px)]"
      : side === "bottom"
        ? "inset-x-0 bottom-0 max-h-[92dvh] w-full rounded-t-3xl"
        : "left-1/2 top-1/2 max-h-[92dvh] w-[min(calc(100vw-2rem),720px)] -translate-x-1/2 -translate-y-1/2 rounded-3xl";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/35 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content
          className={`fixed z-[71] flex min-h-0 flex-col overflow-hidden border border-[#ddd5c9] bg-[#fffdfa] shadow-2xl outline-none ${position} ${contentClassName}`}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {description && <Dialog.Description className="sr-only">{description}</Dialog.Description>}
          {children}
          {showClose && (
            <Dialog.Close
              aria-label={`Close ${title}`}
              className="absolute right-3 top-3 z-10 flex size-11 items-center justify-center rounded-xl border border-[#ded6ca] bg-[#fffdfa] text-slate-600 shadow-sm transition hover:bg-[#f8f4ec] focus-visible:ring-4 focus-visible:ring-[#f1c94b]/50"
            >
              <X className="size-5" />
            </Dialog.Close>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

