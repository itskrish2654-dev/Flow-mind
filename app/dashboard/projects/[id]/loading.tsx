import { LoaderCircle } from "lucide-react";

export default function ProjectLoading() {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center bg-[#f7f4ee] px-6"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] px-8 py-7 text-center shadow-[0_18px_50px_rgba(39,37,54,.08)]">
        <span className="mx-auto flex size-11 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
          <LoaderCircle className="size-5 animate-spin" />
        </span>
        <p className="mt-4 text-[12px] font-semibold text-[#272536]">
          Opening your automation
        </p>
        <p className="mt-1 text-[10px] text-[#64748b]">
          Restoring the saved draft and setup details…
        </p>
      </div>
    </div>
  );
}
