export default function StudentLoading() {
  return (
    <main role="status" aria-label="Loading page" className="mx-auto max-w-[1180px] px-6 py-8">
      <div className="h-8 w-48 rounded-control bg-[var(--surface)] animate-pulse" />
      <div className="mt-3 h-4 w-72 max-w-full rounded-control bg-[var(--surface)] animate-pulse" />
      <div className="mt-7 grid gap-5 sm:grid-cols-2">
        {[0, 1, 2, 3].map(i => <div key={i} className="h-40 rounded-card border border-[var(--border)] bg-white animate-pulse" />)}
      </div>
      <span className="sr-only">Loading page…</span>
    </main>
  );
}
