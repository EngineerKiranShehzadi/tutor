'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const TABS = [
  { href: '/admin/rag-traces', label: 'Overview', icon: 'fas fa-chart-pie', exact: true },
  { href: '/admin/rag-traces/traces', label: 'Traces', icon: 'fas fa-list' },
  { href: '/admin/rag-traces/spans', label: 'Spans', icon: 'fas fa-layer-group' },
  { href: '/admin/rag-traces/sessions', label: 'Sessions', icon: 'fas fa-comments' },
  { href: '/admin/rag-traces/errors', label: 'Errors', icon: 'fas fa-triangle-exclamation' },
  { href: '/admin/rag-traces/health', label: 'System Health', icon: 'fas fa-heart-pulse' },
];

export function ObservabilityTabs() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 border-b border-slate-200 mb-6 overflow-x-auto" role="tablist" aria-label="RAG Observability sections">
      {TABS.map(tab => {
        const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(tab.href + '/');
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={active}
            className={cn(
              'flex items-center gap-2 px-4 py-3 text-[18px] font-semibold border-b-2 whitespace-nowrap transition-colors',
              active ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-200'
            )}
          >
            <i className={cn(tab.icon, 'text-[17px]')} />
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
