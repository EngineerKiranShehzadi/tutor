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

interface AgentDetail { id: number; title: string; status: string; chunkCount: number; createdAt: string; updatedAt: string }

const STATUS_CONFIG: Record<string, { label: string; dot: string; text: string; bg: string; border: string; icon: string; color: string }> = {
  READY:            { label: 'AI Ready',      dot: 'bg-emerald-400', text: 'text-emerald-700', bg: 'bg-emerald-50',  border: 'border-emerald-200', icon: 'fas fa-robot',       color: '#10b981' },
  PROCESSING:       { label: 'Processing',    dot: 'bg-blue-400',    text: 'text-blue-700',    bg: 'bg-blue-50',     border: 'border-blue-200',    icon: 'fas fa-cog fa-spin', color: '#3b82f6' },
  EMBEDDING:        { label: 'Embedding',     dot: 'bg-violet-400',  text: 'text-violet-700',  bg: 'bg-violet-50',   border: 'border-violet-200',  icon: 'fas fa-brain',       color: '#8b5cf6' },
  DATASET_UPLOADED: { label: 'Dataset Ready', dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'bg-amber-50',    border: 'border-amber-200',   icon: 'fas fa-file-check',  color: '#f59e0b' },
  NO_DATASET:       { label: 'No Dataset',    dot: 'bg-slate-400',   text: 'text-slate-600',   bg: 'bg-slate-50',    border: 'border-slate-200',   icon: 'fas fa-database',    color: '#94a3b8' },
  FAILED:           { label: 'Failed',        dot: 'bg-red-400',     text: 'text-red-700',     bg: 'bg-red-50',      border: 'border-red-200',     icon: 'fas fa-circle-xmark',color: '#ef4444' },
};

const PROGRESS: Record<string, number> = { NO_DATASET: 0, DATASET_UPLOADED: 25, PROCESSING: 50, EMBEDDING: 75, READY: 100, FAILED: 0 };
const PROGRESS_COLOR: Record<string, string> = { READY: 'bg-emerald-500', PROCESSING: 'bg-blue-500', EMBEDDING: 'bg-violet-500', DATASET_UPLOADED: 'bg-amber-500', NO_DATASET: 'bg-slate-300', FAILED: 'bg-red-500' };


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
    ready:      agents.filter(a => a.status === 'READY').length,
    processing: agents.filter(a => ['PROCESSING','EMBEDDING','DATASET_UPLOADED'].includes(a.status)).length,
    failed:     agents.filter(a => a.status === 'FAILED').length,
    noDataset:  agents.filter(a => a.status === 'NO_DATASET').length,
  };

  // Donut chart data — only statuses with count > 0
  const donutData = Object.entries({
    READY: summary.ready,
    PROCESSING: summary.processing,
    FAILED: summary.failed,
    NO_DATASET: summary.noDataset,
  })
    .filter(([, v]) => v > 0)
    .map(([key, value]) => ({
      name: STATUS_CONFIG[key]?.label ?? key,
      value,
      color: STATUS_CONFIG[key]?.color ?? '#94a3b8',
    }));

  // Bar chart data — top 8 by chunk count
  const barData = [...agents]
    .sort((a, b) => b.chunkCount - a.chunkCount)
    .slice(0, 8)
    .map(a => ({
      name: a.title.length > 16 ? a.title.slice(0, 14) + '…' : a.title,
      fullName: a.title,
      Chunks: a.chunkCount,
      color: STATUS_CONFIG[a.status]?.color ?? '#94a3b8',
    }));

  return (
    <div className="max-w-[1500px]">
      <AdminPageHero
        icon="fas fa-robot"
        iconGradient="from-violet-500 to-purple-600"
        title="AI Agents"
        subtitle={loading ? 'Loading…' : `${agents.length} total agents · ${summary.ready} ready · Auto-refreshing every 5s`}
        action={
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-2.5 bg-white/15 text-white border border-white/25 backdrop-blur-sm rounded-xl text-[14px] font-semibold hover:bg-white/25 transition-all"
          >
            <i className="fas fa-rotate-right text-[11px]" /> Refresh Now
          </button>
        }
      />

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        {[
          { label: 'AI Ready',    value: summary.ready,      color: 'bg-emerald-600', light: 'bg-emerald-50 text-emerald-700', icon: 'fas fa-robot' },
          { label: 'Processing',  value: summary.processing, color: 'bg-blue-600',    light: 'bg-blue-50 text-blue-700',       icon: 'fas fa-cog' },
          { label: 'Failed',      value: summary.failed,     color: 'bg-red-600',     light: 'bg-red-50 text-red-700',         icon: 'fas fa-circle-xmark' },
          { label: 'No Dataset',  value: summary.noDataset,  color: 'bg-slate-600',   light: 'bg-slate-100 text-slate-600',    icon: 'fas fa-database' },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
            <div className="flex items-start justify-between mb-3">
              <div className={`w-9 h-9 rounded-xl ${c.color} flex items-center justify-center`}>
                <i className={`${c.icon} text-white text-[13px]`} />
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.light}`}>Live</span>
            </div>
            <p className="text-[28px] font-extrabold text-slate-900 leading-none">{loading ? '…' : c.value}</p>
            <p className="text-[13px] text-slate-500 mt-1 font-medium">{c.label}</p>
          </div>
        ))}
      </div>

      {/* Charts row */}
      {!loading && agents.length > 0 && (
        <div className="grid grid-cols-5 gap-5 mb-5">

          {/* Donut — status distribution */}
          <div className="col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h2 className="text-[16px] font-bold text-slate-800 mb-0.5">Status Distribution</h2>
            <p className="text-[12px] text-slate-400 mb-3">Agent pipeline breakdown</p>
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
                    contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                    formatter={(value, name) => [value, name]}
                  />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    formatter={(value) => <span style={{ fontSize: 11, color: '#64748b' }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* Centre label */}
              <div className="absolute top-[18px] left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none" style={{ top: 18 }}>
                <span className="text-[26px] font-extrabold text-slate-900 leading-none">{agents.length}</span>
                <span className="text-[10px] text-slate-400 mt-0.5">agents</span>
              </div>
            </div>
          </div>

          {/* Bar — chunks per agent */}
          <div className="col-span-3 bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h2 className="text-[16px] font-bold text-slate-800 mb-0.5">Knowledge Chunks per Agent</h2>
            <p className="text-[12px] text-slate-400 mb-3">Q&A pairs embedded in each AI agent</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={barData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }} barSize={28}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 500 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: '#f1f5f9', radius: 6 }}
                  contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 12 }}
                  formatter={(value, _, props) => [Number(value) + ' chunks', (props as { payload: { fullName: string } }).payload.fullName]}
                  labelFormatter={() => ''}
                />
                <Bar dataKey="Chunks" radius={[6, 6, 0, 0]}>
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
          <i className="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-[13px]" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by lecture title…"
            className="w-full pl-9 pr-4 py-3 bg-white border border-slate-200 rounded-xl text-[14px] text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className="px-4 py-3 bg-white border border-slate-200 rounded-xl text-[14px] text-slate-700 outline-none focus:border-indigo-400 transition-all">
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
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          {[1,2,3,4].map(i => (
            <div key={i} className="px-6 py-5 border-b border-slate-100 last:border-0 space-y-3">
              <div className="flex items-center gap-3"><div className="w-24 h-4 bg-slate-100 rounded animate-pulse" /><div className="w-16 h-5 bg-slate-100 rounded-full animate-pulse" /></div>
              <div className="w-full h-2 bg-slate-100 rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center justify-center py-20 text-slate-400">
          <i className="fas fa-robot text-3xl mb-3" />
          <p className="text-[17px] font-semibold text-slate-600">No agents found</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="divide-y divide-slate-100">
            {filtered.map(a => {
              const s = STATUS_CONFIG[a.status] ?? STATUS_CONFIG.NO_DATASET;
              const pct = PROGRESS[a.status] ?? 0;
              const barColor = PROGRESS_COLOR[a.status] ?? 'bg-slate-300';
              const isActive = ['PROCESSING','EMBEDDING'].includes(a.status);
              return (
                <div key={a.id} className="px-6 py-5 hover:bg-slate-50/50 transition-colors group">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-[13px] text-slate-400 font-mono shrink-0">#{a.id}</span>
                      <p className="text-[16px] font-semibold text-slate-800 truncate">{a.title}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 ml-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold border ${s.bg} ${s.border} ${s.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${isActive ? 'animate-pulse' : ''}`} />
                        {s.label}
                      </span>
                      <span className="text-[13px] text-slate-400 font-medium">
                        <i className="fas fa-layer-group text-[11px] mr-1" />{a.chunkCount} chunks
                      </span>
                      <Link href={`/admin/lectures/${a.id}`}
                        className="opacity-0 group-hover:opacity-100 transition-opacity px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 text-[12px] font-semibold hover:bg-indigo-100 border border-indigo-100">
                        <i className="fas fa-arrow-up-right-from-square text-[9px] mr-1" />Open
                      </Link>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all duration-700 ${barColor} ${isActive ? 'animate-pulse' : ''}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[11px] text-slate-400 w-10 text-right font-mono">{pct}%</span>
                  </div>

                  {/* Pipeline steps */}
                  <div className="flex items-center gap-2 mt-3">
                    {['NO_DATASET','DATASET_UPLOADED','PROCESSING','EMBEDDING','READY'].map((step, idx) => {
                      const stepPct = PROGRESS[step];
                      const done    = pct > stepPct || a.status === 'READY';
                      const current = a.status === step;
                      return (
                        <div key={step} className="flex items-center gap-2">
                          {idx > 0 && <div className={`h-px w-6 ${done ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
                          <div className={`w-2 h-2 rounded-full ${a.status === 'FAILED' && current ? 'bg-red-500' : done || current ? (STATUS_CONFIG[step]?.dot ?? 'bg-slate-300') : 'bg-slate-200'}`} />
                        </div>
                      );
                    })}
                    <span className="ml-1 text-[11px] text-slate-400">
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
