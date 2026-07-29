'use client';
import { useState } from 'react';
import { useQuery } from '@apollo/client';
import { RadialBarChart, RadialBar, ResponsiveContainer, Tooltip } from 'recharts';
import { GET_CONTENT_GAPS } from '@/graphql/analytics.queries';
import { AdminPageHero } from '@/components/admin/AdminPageHero';

interface LectureGap {
  lectureId:           number;
  lectureTitle:        string;
  questionsAsked:      number;
  chunkCount:          number;
  coverageScore:       number;
  gapTopics:           string[];
  coveredTopics:       string[];
  status:              'GOOD' | 'MODERATE' | 'POOR';
  answeredFromLecture: number;
  notInLecture:        number;
}

const STATUS_CONFIG = {
  GOOD:     { label: 'Well Covered', bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', bar: '#10b981', dot: 'bg-emerald-400', ring: 'ring-emerald-200' },
  MODERATE: { label: 'Partial Gap',  bg: 'bg-amber-50',   border: 'border-amber-200',   text: 'text-amber-700',   bar: '#f59e0b', dot: 'bg-amber-400',   ring: 'ring-amber-200'   },
  POOR:     { label: 'Critical Gap', bg: 'bg-red-50',     border: 'border-red-200',     text: 'text-red-700',     bar: '#ef4444', dot: 'bg-red-400',     ring: 'ring-red-200'     },
};

function CoverageRing({ score, status }: { score: number; status: keyof typeof STATUS_CONFIG }) {
  const color = STATUS_CONFIG[status].bar;
  const data = [{ value: score, fill: color }, { value: 100 - score, fill: '#f1f5f9' }];
  return (
    <div className="relative w-22 h-22 shrink-0" style={{ width: 88, height: 88 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart cx="50%" cy="50%" innerRadius="60%" outerRadius="90%" startAngle={90} endAngle={-270} data={data} barSize={8}>
          <RadialBar dataKey="value" cornerRadius={4} background={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[19px] font-extrabold text-slate-900 leading-none">{score}%</span>
        <span className="text-[10px] text-slate-400 mt-0.5">covered</span>
      </div>
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-100 ${className}`} />;
}

export default function ContentGapsPage() {
  const { data, loading } = useQuery(GET_CONTENT_GAPS, { fetchPolicy: 'network-only' });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [filter, setFilter]     = useState<'ALL' | 'POOR' | 'MODERATE' | 'GOOD'>('ALL');

  const gaps: LectureGap[] = data?.contentGaps ?? [];
  const filtered = filter === 'ALL' ? gaps : gaps.filter(g => g.status === filter);

  const poorCount     = gaps.filter(g => g.status === 'POOR').length;
  const moderateCount = gaps.filter(g => g.status === 'MODERATE').length;
  const goodCount     = gaps.filter(g => g.status === 'GOOD').length;
  const avgCoverage   = gaps.length ? Math.round(gaps.reduce((s, g) => s + g.coverageScore, 0) / gaps.length) : 0;
  const totalAnswered = gaps.reduce((s, g) => s + g.answeredFromLecture, 0);
  const totalNotFound = gaps.reduce((s, g) => s + g.notInLecture, 0);

  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-magnifying-glass-chart"
        iconGradient="from-rose-500 to-pink-600"
        title="Content Gap Detector"
        subtitle="Compares what students ask against each AI agent's training data — reveals topics the AI wasn't trained on"
      />

      {/* Summary cards */}
      {!loading && gaps.length > 0 && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Avg Coverage',       value: `${avgCoverage}%`, icon: 'fas fa-shield-halved',        bg: 'bg-indigo-600'  },
            { label: 'Critical Gaps',      value: poorCount,         icon: 'fas fa-triangle-exclamation', bg: 'bg-red-600'     },
            { label: 'Answered from Lecture', value: totalAnswered,  icon: 'fas fa-circle-check',         bg: 'bg-emerald-600' },
            { label: 'Not in Lecture',     value: totalNotFound,     icon: 'fas fa-circle-xmark',         bg: 'bg-amber-500'   },
          ].map(c => (
            <div key={c.label} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
              <div className="flex items-start justify-between mb-3">
                <div className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center`}>
                  <i className={`${c.icon} text-white text-[14px]`} />
                </div>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">Live</span>
              </div>
              <p className="text-[30px] font-extrabold text-slate-900 leading-none">{c.value}</p>
              <p className="text-[13px] text-slate-500 mt-1 font-medium">{c.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* How it works */}
      <div className="bg-indigo-50 border border-indigo-100 rounded-2xl px-5 py-4 mb-5 flex items-start gap-3">
        <i className="fas fa-circle-info text-indigo-400 text-[16px] mt-0.5 shrink-0" />
        <p className="text-[14px] text-indigo-700 leading-relaxed">
          <strong>How this works:</strong> For each AI-ready lecture, we extract keywords from student questions and compare them against the lecture's Q&A training chunks.
          <span className="text-red-600 font-semibold"> Red topics</span> = students are asking about these but the AI has no training data for them →
          add more Q&A pairs to that lecture's dataset.
          <span className="text-emerald-600 font-semibold"> Green topics</span> = well covered by training data.
        </p>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-5">
        {(['ALL', 'POOR', 'MODERATE', 'GOOD'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-xl text-[13px] font-semibold border transition-colors ${
              filter === f
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}>
            {f === 'ALL' ? `All (${gaps.length})` :
             f === 'POOR' ? `Critical (${poorCount})` :
             f === 'MODERATE' ? `Partial (${moderateCount})` :
             `Covered (${goodCount})`}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="space-y-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-36 w-full rounded-2xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <i className="fas fa-magnifying-glass-chart text-3xl mb-3" />
          <p className="text-[17px] font-semibold text-slate-600">
            {gaps.length === 0 ? 'No data yet' : 'No lectures in this category'}
          </p>
          <p className="text-[14px] mt-1">
            {gaps.length === 0
              ? 'Gaps appear once students ask questions on AI-ready lectures.'
              : 'Try selecting a different filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(gap => {
            const sc = STATUS_CONFIG[gap.status];
            const isOpen = expanded === gap.lectureId;
            return (
              <div key={gap.lectureId}
                className={`bg-white rounded-2xl border shadow-sm overflow-hidden transition-all ${sc.border}`}>

                {/* Card header */}
                <button
                  className="w-full text-left px-6 py-5 flex items-center gap-5 hover:bg-slate-50/60 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : gap.lectureId)}
                >
                  <CoverageRing score={gap.coverageScore} status={gap.status} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                      <h3 className="text-[17px] font-bold text-slate-900 truncate">{gap.lectureTitle}</h3>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[12px] font-semibold border ${sc.bg} ${sc.border} ${sc.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                        {sc.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-[13px] text-slate-500">
                      <span><i className="fas fa-comments mr-1 text-[11px]" />{gap.questionsAsked} question{gap.questionsAsked !== 1 ? 's' : ''}</span>
                      <span><i className="fas fa-layer-group mr-1 text-[11px]" />{gap.chunkCount} training chunks</span>
                      <span className="text-emerald-600 font-medium"><i className="fas fa-check-circle mr-1 text-[11px]" />{gap.answeredFromLecture} answered from lecture</span>
                      <span className="text-red-500 font-medium"><i className="fas fa-times-circle mr-1 text-[11px]" />{gap.notInLecture} not in lecture</span>
                    </div>

                    {/* Coverage bar */}
                    <div className="mt-3 flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${gap.coverageScore}%`, background: sc.bar }} />
                      </div>
                      <span className="text-[12px] text-slate-400 w-8 text-right tabular-nums">{gap.coverageScore}%</span>
                    </div>
                  </div>

                  <i className={`fas fa-chevron-${isOpen ? 'up' : 'down'} text-slate-400 text-[13px] shrink-0`} />
                </button>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="px-6 pb-6 border-t border-slate-100 pt-5">
                    <div className="grid grid-cols-2 gap-6">

                      {/* Gap topics */}
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <i className="fas fa-triangle-exclamation text-red-400 text-[14px]" />
                          <p className="text-[14px] font-bold text-slate-800">Topics Not in Training Data</p>
                        </div>
                        {gap.gapTopics.length === 0 ? (
                          <p className="text-[13px] text-slate-400 italic">No gaps detected — AI covers all asked topics.</p>
                        ) : (
                          <>
                            <div className="flex flex-wrap gap-1.5 mb-3">
                              {gap.gapTopics.map(t => (
                                <span key={t} className="px-2.5 py-1 bg-red-50 border border-red-200 text-red-700 text-[12px] font-semibold rounded-lg">
                                  {t}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
                              <i className="fas fa-lightbulb text-amber-500 text-[13px] mt-0.5 shrink-0" />
                              <p className="text-[12px] text-amber-700 leading-relaxed">
                                <strong>Action needed:</strong> Add Q&A pairs covering these topics to <em>{gap.lectureTitle}</em>'s dataset, then re-embed to improve AI coverage.
                              </p>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Covered topics */}
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <i className="fas fa-circle-check text-emerald-400 text-[14px]" />
                          <p className="text-[14px] font-bold text-slate-800">Topics Well Covered by AI</p>
                        </div>
                        {gap.coveredTopics.length === 0 ? (
                          <p className="text-[13px] text-slate-400 italic">No matching topics found in training data.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {gap.coveredTopics.map(t => (
                              <span key={t} className="px-2.5 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 text-[12px] font-semibold rounded-lg">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
