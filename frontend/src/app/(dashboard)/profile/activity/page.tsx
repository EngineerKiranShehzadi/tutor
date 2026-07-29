'use client';
import { useQuery } from '@apollo/client';
import { MY_STATS_QUERY } from '@/graphql/analytics.queries';
import { cn } from '@/lib/cn';

/* ─── Badge ladder ─────────────────────────────────────────────────────────── */
const BADGE_LADDER = [
  { name: 'Newcomer',        threshold: 0,  gradient: 'from-slate-400 to-slate-500',  icon: 'fa-user-plus', bg: 'bg-slate-600'   },
  { name: 'Getting Started', threshold: 1,  gradient: 'from-violet-500 to-purple-500', icon: 'fa-seedling',  bg: 'bg-violet-600'  },
  { name: 'Regular',         threshold: 3,  gradient: 'from-blue-500 to-indigo-500',   icon: 'fa-star',      bg: 'bg-blue-600'    },
  { name: 'Active Learner',  threshold: 10, gradient: 'from-emerald-500 to-teal-500',  icon: 'fa-bolt',      bg: 'bg-emerald-600' },
  { name: 'Power Learner',   threshold: 20, gradient: 'from-amber-500 to-orange-500',  icon: 'fa-crown',     bg: 'bg-amber-500'   },
];

function peakLabel(h: number | null | undefined) {
  if (h == null) return { label: '—', sub: 'No data yet', icon: 'fa-clock', color: 'bg-slate-500' };
  if (h >= 5  && h < 12) return { label: 'Morning',    sub: `~${h}:00 AM`,              icon: 'fa-sun',               color: 'bg-amber-500'  };
  if (h >= 12 && h < 17) return { label: 'Afternoon',  sub: `~${h % 12 || 12}:00 PM`,   icon: 'fa-cloud-sun',         color: 'bg-orange-400' };
  if (h >= 17 && h < 21) return { label: 'Evening',    sub: `~${h % 12}:00 PM`,          icon: 'fa-moon',              color: 'bg-indigo-500' };
  return                         { label: 'Late Night', sub: `~${h % 12 || 12}:00 AM`,   icon: 'fa-star-and-crescent', color: 'bg-violet-600' };
}

function depthLabel(count: number, max: number) {
  const r = max > 0 ? count / max : 0;
  if (r > 0.66) return { label: 'Deep Dive', bar: 'bg-indigo-500',  text: 'text-indigo-600'  };
  if (r > 0.33) return { label: 'Explored',  bar: 'bg-violet-400',  text: 'text-violet-600'  };
  return               { label: 'Touched',   bar: 'bg-slate-300',   text: 'text-slate-400'   };
}

function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-slate-100', className)} />;
}

/* ─── Page ──────────────────────────────────────────────────────────────────── */
export default function ActivityPage() {
  const { data, loading, refetch } = useQuery(MY_STATS_QUERY, {
    fetchPolicy: 'network-only',
    pollInterval: 30000,
  });
  const s = data?.myStats;

  /* derived */
  const streak     = s?.learningStreak    ?? 0;
  const thisWeek   = s?.thisWeekQuestions ?? 0;
  const lastWeek   = s?.lastWeekQuestions ?? 0;
  const totalQ     = s?.totalQuestions    ?? 0;
  const engaged    = s?.lecturesEngaged   ?? 0;
  const available  = s?.totalAvailableLectures ?? 0;
  const coveragePct = available > 0 ? Math.round((engaged / available) * 100) : 0;
  const weekDelta  = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;

  const weekly      = (s?.weeklyActivity  ?? []) as { day: string; date: string; count: number }[];
  const maxDayCnt   = Math.max(...weekly.map(d => d.count), 1);
  const activeDays  = weekly.filter(d => d.count > 0).length;

  const breakdown   = (s?.lectureBreakdown ?? []) as { lectureId: number; lectureTitle: string; count: number }[];
  const maxLecCnt   = Math.max(...breakdown.map(l => l.count), 1);

  const badgeName   = s?.activityBadge ?? 'Newcomer';
  const currentIdx  = BADGE_LADDER.findIndex(b => b.name === badgeName);
  const current     = BADGE_LADDER[currentIdx] ?? BADGE_LADDER[0];
  const next        = BADGE_LADDER[currentIdx + 1] ?? null;
  const levelPct    = next ? Math.min(100, Math.round((thisWeek / next.threshold) * 100)) : 100;
  const toNext      = next ? Math.max(0, next.threshold - thisWeek) : 0;
  const peak        = peakLabel(s?.peakHour);

  const todayISO    = new Date().toISOString().split('T')[0];

  /* ── KPI cards config ── */
  const kpiCards = [
    {
      label: 'Learning Streak',
      value: streak,
      unit: `day${streak !== 1 ? 's' : ''} in a row`,
      icon: 'fa-fire',
      bg: 'bg-orange-500',
      light: 'bg-orange-50 text-orange-600',
      badge: streak >= 3 ? '🔥' : null,
    },
    {
      label: 'Questions This Week',
      value: thisWeek,
      unit: weekDelta != null ? (weekDelta >= 0 ? `↑ ${weekDelta}% vs last week` : `↓ ${Math.abs(weekDelta)}% vs last week`) : 'this week',
      icon: 'fa-circle-question',
      bg: 'bg-indigo-600',
      light: weekDelta != null && weekDelta >= 0 ? 'bg-emerald-50 text-emerald-600' : weekDelta != null ? 'bg-red-50 text-red-500' : 'bg-indigo-50 text-indigo-600',
      badge: null,
    },
    {
      label: 'Knowledge Coverage',
      value: `${coveragePct}%`,
      unit: `${engaged} of ${available} lecture${available !== 1 ? 's' : ''} explored`,
      icon: 'fa-layer-group',
      bg: 'bg-violet-600',
      light: 'bg-violet-50 text-violet-600',
      badge: null,
    },
    {
      label: 'Curiosity Score',
      value: totalQ,
      unit: totalQ === 0 ? 'questions asked' : totalQ < 10 ? 'great start!' : totalQ < 50 ? 'keep exploring!' : 'questions asked',
      icon: 'fa-brain',
      bg: 'bg-emerald-600',
      light: 'bg-emerald-50 text-emerald-600',
      badge: null,
    },
  ];

  return (
    <div className="bg-slate-50 min-h-full">

      {/* ── Hero banner ── */}
      <div className="relative bg-gradient-to-r from-slate-800 via-slate-700 to-indigo-800 overflow-hidden">
        <div className="absolute -top-10 -right-10 w-56 h-56 rounded-full bg-white/5" />
        <div className="absolute bottom-0 left-1/3 w-40 h-40 rounded-full bg-white/5" />
        <div className="relative px-8 pt-10 pb-14 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-extrabold text-white">Learning Journey</h1>
            <p className="text-slate-400 text-sm mt-1">
              {totalQ > 0
                ? `${totalQ} question${totalQ !== 1 ? 's' : ''} asked · ${engaged} of ${available} lecture${available !== 1 ? 's' : ''} explored`
                : 'Start asking questions to see your learning insights'}
            </p>
          </div>
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="mt-1 flex items-center gap-1.5 text-[12px] text-slate-400 hover:text-white transition-colors disabled:opacity-40"
          >
            <i className={cn('fas fa-rotate-right text-[11px]', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      <div className="p-8">
      <div className="max-w-[1400px]">


        {/* ── KPI cards ── */}
        <div className="grid grid-cols-4 gap-5 mb-6">
          {kpiCards.map(card => (
            <div key={card.label} className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-5">
                <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center shadow-sm', card.bg)}>
                  <i className={cn('fas', card.icon, 'text-white text-[16px]')} />
                </div>
                <div className="flex items-center gap-1.5">
                  {card.badge && <span className="text-lg">{card.badge}</span>}
                  <span className={cn('text-[11px] font-bold px-2.5 py-1 rounded-full', card.light)}>Live</span>
                </div>
              </div>
              {loading ? (
                <Skeleton className="h-10 w-20 mb-1" />
              ) : (
                <p className="text-[42px] font-extrabold text-slate-900 leading-none">{card.value}</p>
              )}
              <p className="text-[14px] text-slate-500 mt-2 font-medium">{card.label}</p>
              <p className="text-[12px] text-slate-400 mt-0.5">{card.unit}</p>
            </div>
          ))}
        </div>

        {/* ── 7-day activity strip ── */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
          <div className="flex items-center gap-8">
            {/* Label */}
            <div className="shrink-0 w-44">
              <p className="text-[15px] font-bold text-slate-700">Weekly Activity</p>
              <p className="text-[13px] text-slate-400 mt-0.5">
                Active <span className="font-semibold text-slate-600">{activeDays}</span> of 7 days
              </p>
              {weekDelta !== null && (
                <p className={cn('text-[12px] font-semibold mt-1.5', weekDelta >= 0 ? 'text-emerald-600' : 'text-red-400')}>
                  {weekDelta > 0 ? `↑ ${weekDelta}% more curious` : weekDelta < 0 ? `↓ ${Math.abs(weekDelta)}% fewer questions` : 'Same as last week'}
                </p>
              )}
            </div>

            {/* Dots row */}
            <div className="flex-1 flex items-end gap-3">
              {weekly.map(d => {
                const isToday = d.date === todayISO;
                const active  = d.count > 0;
                const barH    = Math.max((d.count / maxDayCnt) * 52, active ? 6 : 2);
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-2 group">
                    {/* Bar */}
                    <div className="relative w-full flex items-end justify-center" style={{ height: 52 }}>
                      {active && (
                        <div className="absolute -top-6 left-1/2 -translate-x-1/2 hidden group-hover:flex bg-slate-800 text-white text-[10px] font-bold px-2 py-0.5 rounded-lg pointer-events-none z-10 whitespace-nowrap">
                          {d.count} Q
                        </div>
                      )}
                      <div
                        className={cn('w-full rounded-t-md transition-all',
                          isToday ? 'bg-indigo-500' : active ? 'bg-indigo-200 group-hover:bg-indigo-400' : 'bg-slate-100'
                        )}
                        style={{ height: barH }}
                      />
                    </div>
                    {/* Dot */}
                    <div className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center border-2 text-[10px] font-bold shrink-0',
                      active && isToday  ? 'bg-indigo-600 border-indigo-600 text-white shadow-md'  :
                      active             ? 'bg-indigo-100 border-indigo-300 text-indigo-700'        :
                      isToday            ? 'bg-white border-indigo-400 text-indigo-400'             :
                                           'bg-slate-50 border-slate-200 text-slate-300'
                    )}>
                      {active ? <i className="fas fa-check text-[9px]" /> : d.day.charAt(0)}
                    </div>
                    <span className={cn('text-[11px] font-semibold', isToday ? 'text-indigo-600' : 'text-slate-400')}>
                      {d.day}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* This week vs last week summary */}
            <div className="shrink-0 flex items-center gap-5 pl-4 border-l border-slate-100">
              <div className="text-center">
                <p className="text-[28px] font-extrabold text-indigo-600 leading-none">{thisWeek}</p>
                <p className="text-[12px] text-slate-400 mt-1 font-medium">This week</p>
              </div>
              <div className="w-px h-10 bg-slate-200" />
              <div className="text-center">
                <p className="text-[28px] font-extrabold text-slate-300 leading-none">{lastWeek}</p>
                <p className="text-[12px] text-slate-400 mt-1 font-medium">Last week</p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Bottom grid ── */}
        <div className="grid grid-cols-5 gap-6">

          {/* Level progress — 3 cols */}
          <div className="col-span-3 bg-white rounded-2xl border border-slate-200 p-7 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-[18px] font-bold text-slate-900">Learner Level</h2>
                <p className="text-[13px] text-slate-400 mt-0.5">Progress through knowledge milestones</p>
              </div>
              <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', current.bg)}>
                <i className={cn('fas', current.icon, 'text-white text-[12px]')} />
              </div>
            </div>

            {/* Milestone ladder */}
            <div className="relative mb-8">
              {/* Progress track */}
              <div className="absolute top-5 left-4 right-4 h-0.5 bg-slate-100 z-0">
                <div
                  className={cn('h-full bg-gradient-to-r transition-all', current.gradient)}
                  style={{ width: `${(currentIdx / (BADGE_LADDER.length - 1)) * 100}%` }}
                />
              </div>
              <div className="relative z-10 flex items-start justify-between">
                {BADGE_LADDER.map((b, i) => {
                  const done = i <= currentIdx;
                  return (
                    <div key={b.name} className="flex flex-col items-center gap-2">
                      <div className={cn(
                        'w-10 h-10 rounded-full flex items-center justify-center border-2',
                        done ? cn('bg-gradient-to-br border-transparent shadow-md', b.gradient) : 'bg-white border-slate-200'
                      )}>
                        <i className={cn('fas', b.icon, 'text-[13px]', done ? 'text-white' : 'text-slate-300')} />
                      </div>
                      <span className={cn(
                        'text-[11px] font-semibold text-center leading-tight max-w-[64px]',
                        done ? 'text-slate-700' : 'text-slate-300'
                      )}>
                        {b.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Current badge callout */}
            <div className={cn('inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-white text-[13px] font-bold mb-5 bg-gradient-to-r', current.gradient)}>
              <i className={cn('fas', current.icon, 'text-[11px]')} />
              {current.name}
            </div>

            {/* Progress to next */}
            {next ? (
              <div>
                <div className="flex items-center justify-between text-[13px] mb-2">
                  <span className="text-slate-500 font-semibold">
                    To reach <span className="text-slate-700 font-bold">{next.name}</span>
                  </span>
                  <span className="font-bold text-slate-700">{thisWeek} / {next.threshold} this week</span>
                </div>
                <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={cn('h-full rounded-full bg-gradient-to-r transition-all', current.gradient)}
                    style={{ width: `${levelPct}%` }}
                  />
                </div>
                <p className="text-[12px] text-slate-400 mt-2">
                  {toNext > 0
                    ? <>Ask <span className="font-bold text-slate-700">{toNext} more question{toNext !== 1 ? 's' : ''}</span> this week to level up</>
                    : <span className="text-emerald-600 font-semibold"><i className="fas fa-circle-check mr-1" />Target reached — level up!</span>
                  }
                </p>
              </div>
            ) : (
              <p className="text-[13px] text-amber-600 font-semibold">
                <i className="fas fa-crown mr-1.5" />Maximum level — you're a Power Learner!
              </p>
            )}
          </div>

          {/* Right column — 2 cols */}
          <div className="col-span-2 flex flex-col gap-6">

            {/* Peak learning time */}
            <div className="bg-white rounded-2xl border border-slate-200 p-7 shadow-sm flex-1">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-[18px] font-bold text-slate-900">Peak Learning Time</h2>
                  <p className="text-[13px] text-slate-400 mt-0.5">When you learn best</p>
                </div>
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', peak.color)}>
                  <i className={cn('fas', peak.icon, 'text-white text-[12px]')} />
                </div>
              </div>
              {s?.peakHour != null ? (
                <div>
                  <p className="text-[42px] font-extrabold text-slate-900 leading-none">{peak.label}</p>
                  <p className="text-[14px] text-slate-500 mt-2 font-medium">{peak.sub}</p>
                </div>
              ) : (
                <p className="text-[14px] text-slate-400 italic">Ask questions to reveal your peak time</p>
              )}
            </div>

            {/* Lecture depth */}
            <div className="bg-white rounded-2xl border border-slate-200 p-7 shadow-sm flex-1">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-[18px] font-bold text-slate-900">Lecture Depth</h2>
                  <p className="text-[13px] text-slate-400 mt-0.5">How deep you've gone</p>
                </div>
                <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center">
                  <i className="fas fa-book-open text-white text-[12px]" />
                </div>
              </div>
              {breakdown.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-4 text-slate-400">
                  <i className="fas fa-book text-2xl mb-2" />
                  <p className="text-sm font-medium">No lectures explored yet</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {breakdown.slice(0, 4).map(lec => {
                    const d = depthLabel(lec.count, maxLecCnt);
                    return (
                      <div key={lec.lectureId}>
                        <div className="flex items-center justify-between mb-1">
                          <p className="text-[13px] font-semibold text-slate-700 truncate max-w-[70%]">{lec.lectureTitle}</p>
                          <span className={cn('text-[11px] font-bold', d.text)}>{d.label}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className={cn('h-full rounded-full transition-all', d.bar)}
                            style={{ width: `${Math.round((lec.count / maxLecCnt) * 100)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        </div>

      </div>
      </div>
    </div>
  );
}
