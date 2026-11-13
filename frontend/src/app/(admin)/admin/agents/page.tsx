'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@apollo/client';
import { AdminPageHero } from '@/components/admin/AdminPageHero';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { GET_LECTURE_AGENT_DETAILS } from '@/graphql/admin.queries';

interface AgentDetail { id: number; title: string; status: string; chunkCount: number; qaCount: number; createdAt: string; updatedAt: string; agentProfileStatus: string; chatReady: boolean }

// One rule for every status: navy when the tutor works, light navy while it
// is being prepared, gold when an admin has to act, grey when nothing has
// been uploaded yet. No third colour.
const STATUS_CONFIG: Record<string, { label: string; dot: string; text: string; bg: string; border: string; icon: string; color: string }> = {
  READY:            { label: 'Tutor ready',    dot: 'bg-[var(--accent)]',     text: 'text-[var(--accent)]', bg: 'bg-[var(--accent-soft)]', border: 'border-[var(--border)]', icon: 'fas fa-robot',                color: '#1f3a5f' },
  PROCESSING:       { label: 'Processing',      dot: 'bg-[var(--accent-dim)]', text: 'text-[var(--muted)]',  bg: 'bg-[var(--surface)]',     border: 'border-[var(--border)]', icon: 'fas fa-cog fa-spin',          color: '#8fb0d0' },
  EMBEDDING:        { label: 'Embedding',       dot: 'bg-[var(--accent-dim)]', text: 'text-[var(--muted)]',  bg: 'bg-[var(--surface)]',     border: 'border-[var(--border)]', icon: 'fas fa-brain',                color: '#8fb0d0' },
  DATASET_UPLOADED: { label: 'Material ready',  dot: 'bg-[var(--accent-dim)]', text: 'text-[var(--muted)]',  bg: 'bg-[var(--surface)]',     border: 'border-[var(--border)]', icon: 'fas fa-file-circle-check',    color: '#8fb0d0' },
  NO_DATASET:       { label: 'No material',     dot: 'bg-[var(--muted2)]',     text: 'text-[var(--muted)]',  bg: 'bg-[var(--surface)]',     border: 'border-[var(--border)]', icon: 'fas fa-database',             color: '#8e8e92' },
  FAILED:           { label: 'Failed',          dot: 'bg-[var(--gold)]',       text: 'text-[var(--gold)]',   bg: 'bg-[var(--gold-soft)]',   border: 'border-[var(--border)]', icon: 'fas fa-circle-xmark',         color: '#a35f0d' },
  AGENT_NOT_READY:  { label: 'Needs a tutor',   dot: 'bg-[var(--gold)]',       text: 'text-[var(--gold)]',   bg: 'bg-[var(--gold-soft)]',   border: 'border-[var(--border)]', icon: 'fas fa-triangle-exclamation', color: '#a35f0d' },
};

const PROGRESS: Record<string, number> = { NO_DATASET: 0, DATASET_UPLOADED: 25, PROCESSING: 50, EMBEDDING: 75, READY: 100, FAILED: 0 };
const PROGRESS_COLOR: Record<string, string> = { READY: 'bg-[var(--accent)]', PROCESSING: 'bg-[var(--accent)]', EMBEDDING: 'bg-[var(--accent)]', DATASET_UPLOADED: 'bg-[var(--gold)]', NO_DATASET: 'bg-[var(--border)]', FAILED: 'bg-[var(--gold)]' };


export default function AdminAgentsPage() {
  const { data, loading, refetch } = useQuery(GET_LECTURE_AGENT_DETAILS, { fetchPolicy: 'network-only', pollInterval: 5000 });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  const agents: AgentDetail[] = data?.lectureAgentDetails ?? [];
  const filtered = agents.filter(a => {
    const matchSearch = !search || a.title.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'ALL' || a.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const summary = {
    // "Ready" = what chat can actually serve (READY dataset AND an active agent profile).
    ready:      agents.filter(a => a.chatReady).length,
    needsAgent: agents.filter(a => a.status === 'READY' && !a.chatReady).length,
    processing: agents.filter(a => ['PROCESSING','EMBEDDING','DATASET_UPLOADED'].includes(a.status)).length,
    failed:     agents.filter(a => a.status === 'FAILED').length,
    noDataset:  agents.filter(a => a.status === 'NO_DATASET').length,
  };

  // Donut chart data — only statuses with count > 0
  const donutData = Object.entries({
    READY: summary.ready,
    AGENT_NOT_READY: summary.needsAgent,
    PROCESSING: summary.processing,
    FAILED: summary.failed,
    NO_DATASET: summary.noDataset,
  })
    .filter(([, v]) => v > 0)
    .map(([key, value]) => ({
      name: STATUS_CONFIG[key]?.label ?? key,
      value,
      color: STATUS_CONFIG[key]?.color ?? '#8e8e92',
    }));

  // Bar chart data — top 8 by Q&A pairs
  const barData = [...agents]
    .sort((a, b) => b.qaCount - a.qaCount)
    .slice(0, 8)
    .map(a => ({
      name: a.title.length > 16 ? a.title.slice(0, 14) + '…' : a.title,
      fullName: a.title,
      'Q&A pairs': a.qaCount,
      color: STATUS_CONFIG[a.status]?.color ?? '#8e8e92',
    }));

  return (
    <div className="max-w-[1180px]">
      <AdminPageHero
        icon="fas fa-robot"
        iconGradient=" "
        title="AI Agents"
        subtitle={loading ? 'Loading…' : `${agents.length} total agents · ${summary.ready} ready · Auto-refreshing every 5s`}
        action={
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-2.5 bg-white/15 text-white border border-white/25 rounded-card text-label font-semibold hover:bg-white/25 transition-colors"
          >
            <i className="fas fa-rotate-right text-[11px]" /> Refresh Now
          </button>
        }
      />

      {/* Summary cards */}
      <section className="rounded-card border border-[var(--border)] bg-[var(--card)] divide-x divide-[var(--border)] grid grid-cols-5 mb-5">
        {[
          { label: 'Tutor ready',   value: summary.ready,      icon: 'fas fa-robot' },
          { label: 'Needs a tutor', value: summary.needsAgent, icon: 'fas fa-triangle-exclamation' },
          { label: 'Processing',    value: summary.processing, icon: 'fas fa-cog' },
          { label: 'Failed',        value: summary.failed,     icon: 'fas fa-circle-xmark' },
          { label: 'No material',   value: summary.noDataset,  icon: 'fas fa-database' },
        ].map(c => (
          <div key={c.label} className="px-5 py-5">
            <p className="flex items-center gap-2 text-caption font-medium text-[var(--muted)]">
              <i className={`${c.icon} text-[12px] text-[var(--muted2)]`} aria-hidden="true" />
              {c.label}
            </p>
            <p className="text-h2 font-semibold text-[var(--text)] leading-none mt-2 tabular-nums">{loading ? '…' : c.value}</p>
          </div>
        ))}
      </section>

      {/* Charts row */}
      {!loading && agents.length > 0 && (
        <div className="grid grid-cols-5 gap-5 mb-5">

          {/* Donut — status distribution */}
          <div className="col-span-2 bg-[var(--card)] rounded-card border border-[var(--border)] p-5">
            <h2 className="text-label font-semibold text-[var(--text)] mb-0.5">Status Distribution</h2>
            <p className="text-caption text-[var(--muted2)] mb-3">Agent pipeline breakdown</p>
            <div className="relative">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={donutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={58}
                    outerRadius={82}
                    paddingAngle={3}
                    dataKey="value"
                    labelLine={false}
                  >
                    {donutData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} stroke="none" />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: '1px solid #e5e3df', fontSize: 12 }}
                    formatter={(value, name) => [value, name]}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    formatter={(value) => <span style={{ fontSize: 11, color: '#5f6068' }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* Centre label */}
              <div className="absolute top-[18px] left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none" style={{ top: 18 }}>
                <span className="text-h1 font-semibold text-[var(--text)] leading-none">{agents.length}</span>
                <span className="text-[10px] text-[var(--muted2)] mt-0.5">agents</span>
              </div>
            </div>
          </div>

          {/* Bar — chunks per agent */}
          <div className="col-span-3 bg-[var(--card)] rounded-card border border-[var(--border)] p-5">
            <h2 className="text-label font-semibold text-[var(--text)] mb-0.5">Q&A pairs per Agent</h2>
            <p className="text-caption text-[var(--muted2)] mb-3">Q&A pairs in each AI agent&apos;s live dataset</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={barData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }} barSize={28}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e3df" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10, fill: '#8e8e92', fontWeight: 500 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#8e8e92' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: '#e5e3df', radius: 6 }}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e5e3df', fontSize: 12 }}
                  formatter={(value, _, props) => [`${Number(value)} Q&A pair${Number(value) === 1 ? '' : 's'}`, (props as { payload: { fullName: string } }).payload.fullName]}
                  labelFormatter={() => ''}
                />
                <Bar dataKey="Q&A pairs" radius={[6, 6, 0, 0]}>
                  {barData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--muted2)] text-caption" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by lecture title…"
            className="w-full pl-9 pr-4 py-3 bg-[var(--card)] border border-[var(--border)] rounded-card text-label text-[var(--text)] outline-none focus:border-[var(--accent)] transition-colors" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-4 py-3 bg-[var(--card)] border border-[var(--border)] rounded-card text-label text-[var(--text)] outline-none focus:border-[var(--accent)] transition-colors">
          <option value="ALL">All statuses</option>
          <option value="READY">AI Ready</option>
          <option value="PROCESSING">Processing</option>
          <option value="EMBEDDING">Embedding</option>
          <option value="DATASET_UPLOADED">Dataset Uploaded</option>
          <option value="NO_DATASET">No Dataset</option>
          <option value="FAILED">Failed</option>
        </select>
      </div>

      {loading ? (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
          {[1,2,3,4].map(i => (
            <div key={i} className="px-6 py-5 border-b border-[var(--border)] last:border-0 space-y-3">
              <div className="flex items-center gap-3"><div className="w-24 h-4 bg-[var(--surface)] rounded animate-pulse" /><div className="w-16 h-5 bg-[var(--surface)] rounded-full animate-pulse" /></div>
              <div className="w-full h-2 bg-[var(--surface)] rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] flex flex-col items-center justify-center py-20 text-[var(--muted2)]">
          <i className="fas fa-robot text-display mb-3" />
          <p className="text-h3 font-semibold text-[var(--muted)]">No agents found</p>
        </div>
      ) : (
        <div className="bg-[var(--card)] rounded-card border border-[var(--border)] overflow-hidden">
          <div className="divide-y divide-[var(--border)]">
            {filtered.map(a => {
              const agentNotReady = a.status === 'READY' && !a.chatReady;
              const s = agentNotReady ? STATUS_CONFIG.AGENT_NOT_READY : (STATUS_CONFIG[a.status] ?? STATUS_CONFIG.NO_DATASET);
              const pct = PROGRESS[a.status] ?? 0;
              const barColor = PROGRESS_COLOR[a.status] ?? 'bg-[var(--border)]';
              const isActive = ['PROCESSING','EMBEDDING'].includes(a.status);
              return (
                <div key={a.id} className="px-6 py-5 hover:bg-[var(--surface)] transition-colors group">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-caption text-[var(--muted2)] font-mono shrink-0">#{a.id}</span>
                      <p className="text-label font-semibold text-[var(--text)] truncate">{a.title}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      <span
                        title={agentNotReady ? (a.agentProfileStatus === 'INACTIVE' ? 'The dataset is ready, but this lecture\'s agent profile is inactive.' : 'The dataset is ready, but this lecture has no agent profile.') : undefined}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-caption font-semibold border ${s.bg} ${s.border} ${s.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${isActive ? 'animate-pulse' : ''}`} />
                        {s.label}
                      </span>
                      <span className="text-caption text-[var(--muted2)] font-medium" title={`${a.chunkCount} embedded chunk${a.chunkCount === 1 ? '' : 's'}`}>
                        <i className="fas fa-layer-group text-[11px] mr-1" />{a.qaCount} Q&A pair{a.qaCount === 1 ? '' : 's'}
                      </span>
                      <Link href={`/admin/lectures/${a.id}`}
                        className="opacity-0 group-hover:opacity-100 transition-opacity px-3 py-1.5 rounded-card bg-[var(--accent-soft)] text-[var(--accent)] text-caption font-semibold hover:bg-[var(--accent-soft)] border border-[var(--border)]">
                        <i className="fas fa-arrow-up-right-from-square text-[9px] mr-1" />Open
                      </Link>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-1.5 bg-[var(--surface)] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-colors duration-700 ${barColor} ${isActive ? 'animate-pulse' : ''}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[11px] text-[var(--muted2)] w-10 text-right font-mono">{pct}%</span>
                  </div>

                  {/* Pipeline steps */}
                  <div className="flex items-center gap-2 mt-3">
                    {['NO_DATASET','DATASET_UPLOADED','PROCESSING','EMBEDDING','READY'].map((step, idx) => {
                      const stepPct = PROGRESS[step];
                      const done    = pct > stepPct || a.status === 'READY';
                      const current = a.status === step;
                      return (
                        <div key={step} className="flex items-center gap-2">
                          {idx > 0 && <div className={`h-px w-6 ${done ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`} />}
                          <div className={`w-2 h-2 rounded-full ${a.status === 'FAILED' && current ? 'bg-[var(--gold)]' : done || current ? (STATUS_CONFIG[step]?.dot ?? 'bg-[var(--border)]') : 'bg-[var(--border)]'}`} />
                        </div>
                      );
                    })}
                    <span className="ml-1 text-[11px] text-[var(--muted2)]">
                      Updated {new Date(a.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
