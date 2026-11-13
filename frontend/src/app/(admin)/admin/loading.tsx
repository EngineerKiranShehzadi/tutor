// Preserve the admin sidebar while Next.js prepares a newly selected route.
// Data-heavy pages still own their own granular loading states.
export default function AdminLoading() {
  return (
    <div className="max-w-[1180px] animate-pulse" role="status" aria-label="Loading admin page">
      <div className="mb-6 space-y-3">
        <div className="h-8 w-48 rounded-control bg-[var(--surface)]" />
        <div className="h-4 w-80 max-w-full rounded-control bg-[var(--surface)]" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {[0, 1, 2].map(i => <div key={i} className="h-24 rounded-card border border-[var(--border)] bg-[var(--surface)]" />)}
      </div>
      <div className="h-64 rounded-card border border-[var(--border)] bg-[var(--surface)]" />
      <span className="sr-only">Loading admin page…</span>
    </div>
  );
}
