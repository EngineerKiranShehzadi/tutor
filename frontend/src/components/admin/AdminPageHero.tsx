'use client';
import { cn } from '@/lib/cn';

interface AdminPageHeroProps {
  icon: string;
  iconGradient: string;
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  badge?: string;
}

export function AdminPageHero({ icon, iconGradient, title, subtitle, action, badge }: AdminPageHeroProps) {
  return (
    <div className="relative bg-gradient-to-r from-slate-800 via-slate-700 to-indigo-800 overflow-hidden -mx-8 -mt-8 mb-8">
      <div className="absolute -top-10 -right-10 w-56 h-56 rounded-full bg-white/5 pointer-events-none" />
      <div className="absolute bottom-0 left-1/3 w-40 h-40 rounded-full bg-white/5 pointer-events-none" />
      <div className="absolute top-0 right-1/4 w-24 h-24 rounded-full bg-indigo-500/10 pointer-events-none" />

      {/* Breadcrumb */}
      <div className="relative px-8 pt-5 pb-0 flex items-center gap-1.5 text-[13px] text-white/50">
        <i className="fas fa-shield-halved text-[11px]" />
        <span>Admin</span>
        <i className="fas fa-chevron-right text-[9px]" />
        <span className="text-white/80 font-medium">{title}</span>
      </div>

      <div className="relative px-8 py-6 flex items-center gap-5">
        <div className={cn(
          'w-16 h-16 rounded-2xl bg-gradient-to-br flex items-center justify-center shrink-0 shadow-xl border-2 border-white/20',
          iconGradient
        )}>
          <i className={cn(icon, 'text-white text-[22px]')} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-extrabold text-white">{title}</h1>
            {badge && (
              <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-white/15 text-white/80 border border-white/20 uppercase tracking-widest">
                {badge}
              </span>
            )}
          </div>
          <p className="text-slate-300 text-sm mt-1">{subtitle}</p>
        </div>

        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
