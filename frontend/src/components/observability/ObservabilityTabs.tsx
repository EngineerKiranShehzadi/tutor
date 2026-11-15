'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const TABS = [
  { href: '/admin/rag-traces', label: 'Overview', icon: 'fas fa-chart-column', exact: true },
  { href: '/admin/rag-traces/traces', label: 'Traces', icon: 'fas fa-list' },
  { href: '/admin/rag-traces/spans', label: 'Spans', icon: 'fas fa-layer-group' },
  { href: '/admin/rag-traces/sessions', label: 'Sessions', icon: 'fas fa-comments' },
  { href: '/admin/rag-traces/errors', label: 'Errors', icon: 'fas fa-triangle-exclamation' },
  { href: '/admin/rag-traces/health', label: 'System Health', icon: 'fas fa-heart-pulse' },
];

export function ObservabilityTabs() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 border-b border-[var(--border)] mb-6 overflow-x-auto" role="tablist" aria-label="RAG Observability sections">
      {TABS.map(tab => {
        const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(tab.href + '/');
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={cn(
              'flex items-center gap-2 px-4 py-3 text-label font-semibold border-b-2 whitespace-nowrap transition-colors',
              active ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--border)]'
            )}
          >
            <i className={cn(tab.icon, 'text-label')} />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
