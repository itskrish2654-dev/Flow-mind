import { CheckCircle2, Clock3, FileClock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export default function ExecutionLogsPage() {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-5 py-10 sm:px-8 lg:px-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-violet-600">What has happened</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Activity</h1>
          <p className="mt-2 text-sm text-slate-500">See what your automations have done.</p>
        </div>
        <Badge variant="outline" className="gap-1.5 border-slate-200 bg-white text-slate-500">
          <Clock3 className="size-3" /> Live
        </Badge>
      </div>

      <Card className="mt-10 items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white/70 px-6 py-16 text-center shadow-none ring-0">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-violet-50 text-violet-500"><FileClock className="size-5" /></span>
        <CardContent className="px-0">
          <h2 className="text-sm font-semibold text-slate-800">No activity yet</h2>
          <p className="mt-1 text-xs text-slate-500">Once an automation runs, you will see the result here.</p>
          <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-emerald-600"><CheckCircle2 className="size-3.5" /> Ready when you are</div>
        </CardContent>
      </Card>
    </div>
  );
}
