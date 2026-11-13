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
  sampled:             boolean;
  chunksSampled:       boolean;
  windowDays:          number;
}

const STATUS_CONFIG = {
  GOOD:     { label: 'Well Covered', bg: 'bg-[var(--accent-soft)]', border: 'border-[var(--border)]', text: 'text-[var(--accent)]', bar: '#1f3a5f', dot: 'bg-[var(--accent)]', ring: '' },
  MODERATE: { label: 'Partial Gap',  bg: 'bg-[var(--gold-soft)]',   border: 'border-[var(--border)]',   text: 'text-[var(--gold)]',   bar: '#c2802f', dot: 'bg-[var(--gold)]',   ring: ''   },
  POOR:     { label: 'Critical Gap', bg: 'bg-[var(--gold-soft)]',     border: 'border-[var(--border)]',     text: 'text-[var(--gold)]',     bar: '#a35f0d', dot: 'bg-[var(--gold)]',     ring: ''     },
};

function CoverageRing({ score, status }: { score: number; status: keyof typeof STATUS_CONFIG }) {
  const color = STATUS_CONFIG[status].bar;
  const data = [{ value: score, fill: color }, { value: 100 - score, fill: '#e5e3df' }];
  return (
    <div className="relative w-22 h-22 shrink-0" style={{ width: 88, height: 88 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart cx="50%" cy="50%" innerRadius="60%" outerRadius="90%" startAngle={90} endAngle={-270} data={data} barSize={8}>
          <RadialBar dataKey="value" cornerRadius={4} background={false} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-h2 font-semibold text-[var(--text)] leading-none">{score}%</span>
        <span className="text-[10px] text-[var(--muted2)] mt-0.5">covered</span>
      </div>
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-card bg-[var(--surface)] ${className}`} />;
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
    <div className="max-w-[1180px]">
      <AdminPageHero
        icon="fas fa-magnifying-glass-chart"
        iconGradient=" "
        title="Content Gap Detector"
        subtitle="Compares what students ask against each AI agent's training data — reveals topics the AI wasn't trained on"
      />

      {/* Summary cards */}
      {!loading && gaps.length > 0 && (
        <section className="rounded-card border border-[var(--border)] bg-[var(--card)] divide-x divide-[var(--border)] grid grid-cols-4 mb-5">
          {[
            { label: 'Average coverage',   value: `${avgCoverage}%`, icon: 'fas fa-shield-halved',        note: 'across every ready lecture' },
            { label: 'Critical gaps',      value: poorCount,         icon: 'fas fa-triangle-exclamation', note: 'lectures needing material' },
            { label: 'Answered',           value: totalAnswered,     icon: 'fas fa-circle-check',         note: 'from the lecture itself' },
            { label: 'Not covered',        value: totalNotFound,     icon: 'fas fa-circle-xmark',         note: 'no material behind them' },
          ].map(c => (
            <div key={c.label} className="px-6 py-5">
              <p className="flex items-center gap-2 text-caption font-medium text-[var(--muted)]">
                <i className={`${c.icon} text-[12px] text-[var(--muted2)]`} aria-hidden="true" />
                {c.label}
              </p>
              <p className="text-h2 font-semibold text-[var(--text)] leading-none mt-2 tabular-nums">{c.value}</p>
              <p className="text-caption text-[var(--muted)] mt-2">{c.note}</p>
            </div>
          ))}
        </section>
      )}

      {/* How it works */}
      <div className="rounded-card border border-[var(--border)] bg-[var(--card)] px-5 py-4 mb-5 flex items-start gap-3">
        <i className="fas fa-circle-info text-[var(--muted2)] text-label mt-0.5 shrink-0" />
        <p className="text-label text-[var(--muted)] leading-relaxed">
          Keywords from student questions{gaps[0] ? ` of the last ${gaps[0].windowDays} days` : ''} are compared against each lecture&apos;s material.
          <span className="font-semibold"> Missing</span> topics are being asked about with no material behind them, so they are what the next upload should cover.
          <span className="font-semibold"> Covered</span> topics already have it.
          {gaps.some(g => g.sampled) && <span> Only the most recent questions were analysed.</span>}
          {gaps.some(g => g.chunksSampled) && <span> For large lectures, only part of the material was compared.</span>}
        </p>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-5">
        {(['ALL', 'POOR', 'MODERATE', 'GOOD'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-card text-caption font-semibold border transition-colors ${
              filter === f
                ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                : 'bg-[var(--card)] text-[var(--muted)] border-[var(--border)] hover:bg-[var(--surface)]'
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
          {[1,2,3].map(i => <Skeleton key={i} className="h-36 w-full rounded-card" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] flex flex-col items-center justify-center py-20 text-[var(--muted2)]">
          <i className="fas fa-magnifying-glass-chart text-display mb-3" />
          <p className="text-h3 font-semibold text-[var(--muted)]">
            {gaps.length === 0 ? 'No data yet' : 'No lectures in this category'}
          </p>
          <p className="text-label mt-1">
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
                className={`bg-[var(--card)] rounded-card border  overflow-hidden transition-colors ${sc.border}`}>

                {/* Card header */}
                <button
                  className="w-full text-left px-6 py-5 flex items-center gap-5 hover:bg-[var(--surface)] transition-colors"
                  onClick={() => setExpanded(isOpen ? null : gap.lectureId)}
                >
                  <CoverageRing score={gap.coverageScore} status={gap.status} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                      <h3 className="text-h3 font-semibold text-[var(--text)] truncate">{gap.lectureTitle}</h3>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-caption font-semibold border ${sc.bg} ${sc.border} ${sc.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                        {sc.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-caption text-[var(--muted)]">
                      <span><i className="fas fa-comments mr-1 text-[11px]" />{gap.questionsAsked} question{gap.questionsAsked !== 1 ? 's' : ''}</span>
                      <span><i className="fas fa-layer-group mr-1 text-[11px]" />{gap.chunkCount} training chunks</span>
                      <span className="text-[var(--accent)] font-medium"><i className="fas fa-check-circle mr-1 text-[11px]" />{gap.answeredFromLecture} answered from lecture</span>
                      <span className="text-[var(--gold)] font-medium"><i className="fas fa-times-circle mr-1 text-[11px]" />{gap.notInLecture} not in lecture</span>
                    </div>

                    {/* Coverage bar */}
                    <div className="mt-3 flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-[var(--surface)] rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-colors duration-700" style={{ width: `${gap.coverageScore}%`, background: sc.bar }} />
                      </div>
                      <span className="text-caption text-[var(--muted2)] w-8 text-right tabular-nums">{gap.coverageScore}%</span>
                    </div>
                  </div>

                  <i className={`fas fa-chevron-${isOpen ? 'up' : 'down'} text-[var(--muted2)] text-caption shrink-0`} />
                </button>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="px-6 pb-6 border-t border-[var(--border)] pt-5">
                    <div className="grid grid-cols-2 gap-6">

                      {/* Gap topics */}
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <i className="fas fa-triangle-exclamation text-[var(--gold)] text-label" />
                          <p className="text-label font-semibold text-[var(--text)]">Topics Not in Training Data</p>
                        </div>
                        {gap.gapTopics.length === 0 ? (
                          <p className="text-caption text-[var(--muted2)] italic">No gaps detected — AI covers all asked topics.</p>
                        ) : (
                          <>
                            <div className="flex flex-wrap gap-1.5 mb-3">
                              {gap.gapTopics.map(t => (
                                <span key={t} className="px-2.5 py-1 bg-[var(--gold-soft)] border border-[var(--border)] text-[var(--gold)] text-caption font-semibold rounded-card">
                                  {t}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-start gap-2 bg-[var(--gold-soft)] border border-[var(--border)] rounded-card px-3 py-2.5">
                              <i className="fas fa-lightbulb text-[var(--gold)] text-caption mt-0.5 shrink-0" />
                              <p className="text-caption text-[var(--gold)] leading-relaxed">
                                <strong>Action needed:</strong> Add Q&A pairs covering these topics to <em>{gap.lectureTitle}</em>'s dataset, then re-embed to improve AI coverage.
                              </p>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Covered topics */}
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <i className="fas fa-circle-check text-[var(--accent)] text-label" />
                          <p className="text-label font-semibold text-[var(--text)]">Topics Well Covered by AI</p>
                        </div>
                        {gap.coveredTopics.length === 0 ? (
                          <p className="text-caption text-[var(--muted2)] italic">No matching topics found in training data.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {gap.coveredTopics.map(t => (
                              <span key={t} className="px-2.5 py-1 bg-[var(--accent-soft)] border border-[var(--border)] text-[var(--accent)] text-caption font-semibold rounded-card">
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
