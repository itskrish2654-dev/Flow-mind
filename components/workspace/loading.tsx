export function WorkspaceLoading() {
  return <div className="work-loading" role="status" aria-live="polite" aria-busy="true">
    <p className="work-eyebrow">YOUR WORKSPACE</p><p className="mt-3 text-xl font-semibold">Loading your work…</p>
    <p className="mt-2 text-sm text-slate-600">Checking your current access and loading the latest saved state.</p>
    <div className="mt-8 space-y-4" aria-hidden="true"><div className="h-3 w-2/3 rounded bg-[#e4ddd2]" /><div className="h-3 w-1/2 rounded bg-[#e4ddd2]" /><div className="h-3 w-3/4 rounded bg-[#e4ddd2]" /></div>
  </div>;
}
