'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';

/* ─────────────────────────────────── DATA */

const SLIDES = [
  { tag: 'AI-Powered Islamic Learning', title: 'Your Personal Tutor\nFor Every Lecture', body: 'Ask any question and receive answers drawn exclusively from your course content — precise, sourced, and never hallucinated.', accent: '#065fd4', tagColor: '#60a5fa', icon: 'fas fa-robot' },
  { tag: 'Voice-Powered Interaction',   title: 'Speak Your Question,\nHear the Answer',   body: 'Switch to voice mode for a fully hands-free experience. The AI listens, thinks, and speaks back to you in real time.',             accent: '#7c3aed', tagColor: '#a78bfa', icon: 'fas fa-microphone' },
  { tag: 'Knowledge Integrity',         title: 'RAG-Scoped AI.\nZero Hallucinations.',     body: 'Every agent answers only what the instructor taught. Powered by Gemini embeddings + pgvector — no internet, no guessing.',          accent: '#059669', tagColor: '#34d399', icon: 'fas fa-shield-halved' },
];

const CHAT_DEMO = [
  { role: 'user', text: 'What is the definition of Fiqh?' },
  { role: 'ai',   text: 'Fiqh is Islamic jurisprudence — the human understanding of Sharia derived from the Quran, Sunnah, Ijma (scholarly consensus) and Qiyas (analogical reasoning).', sources: ['Topic: Introduction to Islamic Law', 'Lecture 1 · 02:14'] },
  { role: 'user', text: 'What are the four major schools of Fiqh?' },
  { role: 'ai',   text: "The four Sunni madhabs are: Hanafi, Maliki, Shafi'i, and Hanbali — each founded by a great scholar and followed by millions globally.", sources: ['Topic: Schools of Jurisprudence', 'Lecture 1 · 08:40'] },
];

const PLAYLIST = [
  { title: 'Introduction to Islamic Jurisprudence', ready: true,  active: true  },
  { title: 'Sources of Fiqh — Quran & Sunnah',      ready: true,  active: false },
  { title: 'Ijma and Qiyas Explained',               ready: true,  active: false },
  { title: 'The Four Major Madhabs',                  ready: false, active: false },
];

const STATS = [
  { value: 100, suffix: '%', label: 'Lecture-Sourced Answers', icon: 'fas fa-bullseye', color: '#065fd4' },
  { value: 3072, suffix: 'd', label: 'Gemini Embedding Dims',  icon: 'fas fa-brain',    color: '#7c3aed' },
  { value: 0,   suffix: 'ms', label: 'Hallucination Rate',     icon: 'fas fa-ban',      color: '#059669' },
  { value: 2,   suffix: ' modes', label: 'Text + Voice Input', icon: 'fas fa-microphone', color: '#d97706' },
];

const FEATURES = [
  { icon: 'fas fa-bullseye',     bg: '#065fd4', title: 'Lecture-Scoped Answers',     body: "Every AI agent is strictly bound to its lecture's dataset. Students physically cannot receive answers from other lectures or the internet — only what the instructor explicitly taught.", points: ['Per-lecture RAG pipeline with pgvector', 'Cosine similarity search (3072-dim embeddings)', 'Source topic + timestamp on every response'] },
  { icon: 'fas fa-microphone-lines', bg: '#7c3aed', title: 'Full Voice Interaction', body: 'Complete text-to-speech and speech-to-text built natively into the chat drawer. Students speak questions naturally, hear AI answers, and study completely hands-free.',            points: ['Chrome/Edge STT via webkitSpeechRecognition', 'Cross-browser TTS via speechSynthesis API',        'Auto-sends after 1.5 s of silence detected']     },
  { icon: 'fas fa-chart-pie',    bg: '#d97706', title: 'Real-Time Admin Analytics',  body: 'Instructors get a full admin console showing live engagement per lecture, student activity, AI agent readiness pipeline, and the ability to manage lectures and datasets.',          points: ['Questions-per-lecture engagement chart',       'Recent student questions feed',                     'AI agent status: Processing → Embedding → Ready']  },
];

const TESTIMONIALS = [
  { name: 'Mahnoor Saleha',  role: 'BS SE Student · COMSATS University Lahore', avatar: 'MS', color: '#e91e8c', gender: 'f', quote: 'I was struggling with Fiqh definitions until AskAITutor cited exactly where each concept appeared in the lecture. The source timestamps made revision so much easier before exams.' },
  { name: 'Maryam Munawer',  role: 'BS SE Student · COMSATS University Lahore', avatar: 'MM', color: '#7c3aed', gender: 'f', quote: 'The voice mode is a game changer for me. I revise while commuting — I just ask questions out loud and the AI responds instantly. It feels like a personal tutor available 24/7.' },
  { name: 'Khuld Zulfiqar',  role: 'BS SE Student · COMSATS University Lahore', avatar: 'KZ', color: '#059669', gender: 'f', quote: 'What impressed me most is that the AI only answers from the lecture content. No random internet answers — every response is traceable back to the exact topic taught in class.' },
];

const FAQS = [
  { q: 'Is the AI Tutor connected to the internet?',               a: 'No. The AI strictly retrieves answers from the uploaded lecture dataset using vector search. It never queries the internet, Wikipedia, or any external source. This guarantees every answer came from the instructor.' },
  { q: 'Can a student ask questions from a different lecture?',     a: 'No. Each AI agent is scoped to exactly one lecture. If a student asks something outside that lecture\'s dataset, the AI responds with a fallback message clarifying it cannot answer from outside scope.' },
  { q: 'How long does it take to activate a new lecture?',         a: 'After uploading the Excel dataset (.xlsx), the system processes and embeds all Q&A pairs automatically. For a typical dataset of 100–300 rows, activation takes 2–5 minutes. The admin panel shows live status.' },
  { q: 'Does voice mode work on all browsers?',                    a: 'Text-to-speech (AI speaking) works in all modern browsers. Voice input (student speaking) requires Chrome or Edge — this is a browser API limitation. Firefox and Safari users see the mic button disabled with a clear tooltip.' },
  { q: 'How accurate are the AI answers?',                         a: 'Accuracy depends on the quality of the uploaded dataset. Since answers are retrieved via RAG (not generated freely), the AI can only say what the dataset contains — reducing hallucination risk to near zero.' },
  { q: 'Can the admin see what students are asking?',              a: 'Yes. The admin dashboard shows all student questions across all lectures, including who asked, which lecture it was for, and the exact timestamp — giving instructors full visibility into learning gaps.' },
];

const WHY_ROWS = [
  { aspect: 'Answer Source',       ai: 'Exclusively from your lecture',    old: 'Internet / Wikipedia / guesses'    },
  { aspect: 'Hallucination Risk',  ai: 'Near zero (RAG-sourced)',           old: 'High with general LLMs'            },
  { aspect: 'Source References',   ai: 'Topic + timestamp on every reply', old: 'None'                              },
  { aspect: 'Voice Interaction',   ai: 'Built-in TTS + STT',               old: 'Not available'                     },
  { aspect: 'Chat History',        ai: 'Saved per student per lecture',     old: 'Lost on page reload'               },
  { aspect: 'Admin Analytics',     ai: 'Live dashboard + question logs',    old: 'No visibility'                     },
];

/* ─────────────────────────────────── COUNTER HOOK */
function useCounter(target: number, duration = 1200, start = false) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!start || target === 0) { setVal(target); return; }
    const steps = 40;
    const inc   = target / steps;
    let cur = 0;
    const id = setInterval(() => {
      cur += inc;
      if (cur >= target) { setVal(target); clearInterval(id); }
      else setVal(Math.floor(cur));
    }, duration / steps);
    return () => clearInterval(id);
  }, [start, target, duration]);
  return val;
}

/* ─────────────────────────────────── COMPONENT */
export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [activeSlide,  setActiveSlide]  = useState(0);
  const [slideVisible, setSlideVisible] = useState(true);
  const [chatIdx,      setChatIdx]      = useState(0);
  const [showTyping,   setShowTyping]   = useState(false);
  const [voiceActive,  setVoiceActive]  = useState(false);
  const [openFaq,      setOpenFaq]      = useState<number | null>(null);
  const [statsVisible, setStatsVisible] = useState(false);

  const statsRef = useRef<HTMLDivElement>(null);

  /* redirect logged-in users */
  useEffect(() => {
    if (isLoading || !user) return;
    router.replace(user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
  }, [user, isLoading, router]);

  /* hero slide rotation */
  useEffect(() => {
    const id = setInterval(() => {
      setSlideVisible(false);
      setTimeout(() => { setActiveSlide((i) => (i + 1) % SLIDES.length); setSlideVisible(true); }, 500);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  /* chat demo sequential reveal */
  useEffect(() => {
    let current = 0;
    const advance = () => {
      if (current >= CHAT_DEMO.length) return;
      setShowTyping(true);
      const delay = CHAT_DEMO[current].role === 'ai' ? 1300 : 500;
      setTimeout(() => { setShowTyping(false); setChatIdx(current + 1); current++; if (current < CHAT_DEMO.length) setTimeout(advance, 900); }, delay);
    };
    const init = setTimeout(advance, 700);
    return () => clearTimeout(init);
  }, []);

  /* voice pulse */
  useEffect(() => {
    const id = setInterval(() => setVoiceActive((v) => !v), 2200);
    return () => clearInterval(id);
  }, []);

  /* intersection observers */
  const makeObserver = useCallback((setter: (v: boolean | number) => void, stagger = false, total = 0) =>
    new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      if (!stagger) { (setter as (v: boolean) => void)(true); return; }
      let c = 0;
      const id = setInterval(() => { c++; (setter as (v: number) => void)(c); if (c >= total) clearInterval(id); }, 150);
    }, { threshold: 0.12 }), []);

  useEffect(() => {
    const obs = makeObserver((v) => setStatsVisible(v as boolean));
    if (statsRef.current) obs.observe(statsRef.current);
    return () => obs.disconnect();
  }, [makeObserver]);

  const s0 = useCounter(STATS[0].value, 1200, statsVisible);
  const s1 = useCounter(STATS[1].value, 1600, statsVisible);
  const s2 = useCounter(STATS[2].value, 800,  statsVisible);
  const s3 = useCounter(STATS[3].value, 1000, statsVisible);
  const counters = [s0, s1, s2, s3];

  const slide = SLIDES[activeSlide];

  if (isLoading || user) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#060d1f' }}>
      <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen overflow-x-hidden" style={{ color: 'var(--text)', fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* ══════════════════════════════════════════ NAVBAR */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/10" style={{ background: 'rgba(6,13,31,0.96)', backdropFilter: 'blur(12px)' }}>
        <div className="max-w-7xl mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #065fd4, #1a7fe8)' }}>
              <i className="fas fa-robot text-white text-[14px]" />
            </div>
            <span className="text-[17px] font-extrabold text-white">AskAI<span style={{ color: '#60a5fa' }}>Tutor</span></span>
          </div>
          <div className="hidden md:flex items-center gap-7 text-[13px] font-medium" style={{ color: '#94a3b8' }}>
            {['#features', '#demo', '#how', '#faq'].map((h) => (
              <a key={h} href={h} className="hover:text-white transition-colors capitalize">{h.slice(1)}</a>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login" className="px-4 py-2 text-[13px] font-semibold rounded-lg transition-colors" style={{ color: '#94a3b8' }}>Sign In</Link>
            <Link href="/signup" className="px-5 py-2.5 text-[13px] font-bold text-white rounded-xl shadow-lg transition-all hover:scale-105" style={{ background: 'linear-gradient(135deg,#065fd4,#1a7fe8)' }}>Get Started Free</Link>
          </div>
        </div>
      </nav>

      {/* ══════════════════════════════════════════ HERO */}
      <section className="relative flex items-center pt-16 overflow-hidden" style={{ minHeight: '100vh', background: 'linear-gradient(140deg,#060d1f 0%,#0d1f45 45%,#060d1f 100%)' }}>
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle,#fff 1px,transparent 1px)', backgroundSize: '38px 38px' }} />
        <div className="absolute top-1/3 left-1/4  w-[600px] h-[600px] rounded-full opacity-[0.07] blur-3xl pointer-events-none" style={{ background: '#065fd4' }} />
        <div className="absolute bottom-1/4 right-1/5 w-[400px] h-[400px] rounded-full opacity-[0.06] blur-3xl pointer-events-none" style={{ background: '#7c3aed' }} />

        <div className="relative max-w-7xl mx-auto px-8 py-20 w-full grid grid-cols-2 gap-16 items-center">
          {/* Left */}
          <div>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[12px] font-bold mb-6 border"
              style={{ opacity: slideVisible ? 1 : 0, transition: 'opacity .5s', background: `${slide.accent}18`, borderColor: `${slide.accent}44`, color: slide.tagColor }}>
              <i className={`${slide.icon} text-[11px]`} />{slide.tag}
            </div>
            <h1 className="text-[58px] font-black leading-[1.06] text-white mb-6 whitespace-pre-line"
              style={{ opacity: slideVisible ? 1 : 0, transform: slideVisible ? 'translateY(0)' : 'translateY(14px)', transition: 'opacity .5s, transform .5s' }}>
              {slide.title}
            </h1>
            <p className="text-[17px] leading-relaxed mb-10 max-w-[500px]"
              style={{ color: '#94a3b8', opacity: slideVisible ? 1 : 0, transition: 'opacity .5s .1s' }}>
              {slide.body}
            </p>
            <div className="flex flex-wrap gap-4 mb-10">
              <Link href="/signup" className="flex items-center gap-2.5 px-8 py-4 text-[15px] font-bold text-white rounded-2xl shadow-xl hover:scale-105 transition-transform"
                style={{ background: 'linear-gradient(135deg,#065fd4,#1a7fe8)' }}>
                <i className="fas fa-graduation-cap" /> Start Learning Free
              </Link>
              <Link href="/login" className="flex items-center gap-2.5 px-8 py-4 text-[15px] font-semibold rounded-2xl border hover:bg-white/10 transition-colors"
                style={{ color: '#94a3b8', borderColor: '#334155' }}>
                Sign In <i className="fas fa-arrow-right text-[12px]" />
              </Link>
            </div>
            <div className="flex items-center gap-3">
              {SLIDES.map((_, i) => (
                <button key={i} onClick={() => { setSlideVisible(false); setTimeout(() => { setActiveSlide(i); setSlideVisible(true); }, 500); }}
                  className="rounded-full transition-all duration-500"
                  style={{ width: i === activeSlide ? 28 : 8, height: 8, background: i === activeSlide ? '#065fd4' : '#334155' }} />
              ))}
              <span className="text-[11px] ml-1" style={{ color: '#475569' }}>{activeSlide + 1} / {SLIDES.length}</span>
            </div>

            {/* Trust row */}
            <div className="flex items-center gap-4 mt-8 pt-8 border-t border-white/10">
              {[
                { icon: 'fas fa-lock',          text: 'No internet access' },
                { icon: 'fas fa-database',       text: 'pgvector powered' },
                { icon: 'fas fa-microphone',     text: 'Voice enabled' },
              ].map(({ icon, text }) => (
                <div key={text} className="flex items-center gap-1.5 text-[12px]" style={{ color: '#64748b' }}>
                  <i className={`${icon} text-[11px]`} style={{ color: '#60a5fa' }} />{text}
                </div>
              ))}
            </div>
          </div>

          {/* Right — browser mockup */}
          <div className="relative">
            <div className="rounded-2xl overflow-hidden shadow-[0_40px_100px_rgba(0,0,0,0.7)] border border-white/10">
              {/* browser chrome */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10" style={{ background: '#1a2740' }}>
                <div className="flex gap-1.5">
                  {['#ef4444','#f59e0b','#22c55e'].map((c) => <div key={c} style={{ width: 11, height: 11, borderRadius: '50%', background: c + 'cc' }} />)}
                </div>
                <div className="flex-1 mx-3 rounded-md px-3 py-1 text-[11px]" style={{ background: 'rgba(255,255,255,0.08)', color: '#64748b' }}>
                  localhost:3000/lecture/1
                </div>
              </div>

              {/* page layout */}
              <div className="flex" style={{ height: 420, background: '#f9f9f9' }}>
                {/* main */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* fake YT player */}
                  <div className="bg-black flex items-center justify-center shrink-0" style={{ aspectRatio: '16/9', maxHeight: 195 }}>
                    <div className="text-center">
                      <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center mx-auto mb-2 hover:bg-white/30 transition-colors cursor-pointer">
                        <i className="fas fa-play text-white text-sm ml-1" />
                      </div>
                      <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 9 }}>Introduction to Islamic Jurisprudence</p>
                      <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: 8 }}>Fazal Qadir Khan Islamic Institute · 24:15</p>
                    </div>
                  </div>
                  {/* lecture info */}
                  <div className="px-3 py-2 flex-1 overflow-hidden">
                    <p style={{ fontSize: 11, fontWeight: 700, color: '#111', marginBottom: 4, lineHeight: 1.3 }}>
                      Lecture 1 — Introduction to Islamic Jurisprudence (Fiqh)
                    </p>
                    <div className="flex items-center gap-2 mb-2.5">
                      <div className="w-5 h-5 rounded-full bg-purple-600 flex items-center justify-center text-white shrink-0" style={{ fontSize: 7, fontWeight: 700 }}>FQ</div>
                      <span style={{ fontSize: 9, color: '#555', fontWeight: 600 }}>Fazal Qadir Khan Islamic Institute</span>
                    </div>
                    {/* AI ready bar */}
                    <div className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: '#065fd4' }}>
                      <i className="fas fa-robot text-white" style={{ fontSize: 10 }} />
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'white', flex: 1 }}>Ask AI Tutor</span>
                      <div className="flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: '#22c55e', fontSize: 8, color: 'white', fontWeight: 700 }}>
                        <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse inline-block" />AI Ready
                      </div>
                    </div>
                  </div>
                </div>

                {/* playlist sidebar */}
                <div className="shrink-0 border-l flex flex-col overflow-hidden" style={{ width: 170, borderColor: '#e5e5e5', background: 'white' }}>
                  <div className="px-3 py-2.5 border-b" style={{ borderColor: '#f0f0f0' }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color: '#111' }}>Course Lectures</p>
                    <p style={{ fontSize: 8, color: '#888' }}>4 lectures total</p>
                  </div>
                  <div className="flex-1 overflow-hidden py-1.5 px-1.5" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {PLAYLIST.map((lec, i) => (
                      <div key={i} className="flex gap-2 rounded-lg p-1.5" style={{ background: lec.active ? '#eff6ff' : 'transparent' }}>
                        <div className="shrink-0 flex items-center justify-center pt-0.5" style={{ width: 14 }}>
                          {lec.active ? <i className="fas fa-play" style={{ color: '#ef4444', fontSize: 7 }} /> : <span style={{ fontSize: 8, color: '#999' }}>{i + 1}</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p style={{ fontSize: 8, fontWeight: 600, color: lec.active ? '#065fd4' : '#333', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{lec.title}</p>
                          <span style={{ fontSize: 7, fontWeight: 700, color: lec.ready ? '#16a34a' : '#999' }}>{lec.ready ? '🟢 AI Ready' : '⏳ Preparing'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* chat drawer */}
              <div className="border-t-2 px-4 py-3" style={{ background: 'white', borderColor: '#065fd4' }}>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <div className="w-7 h-7 rounded-lg overflow-hidden shrink-0">
                    <Image src="/agent-avatar.png" alt="AI" width={28} height={28} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p style={{ fontSize: 11, fontWeight: 700, color: '#111' }}>AI Tutor — Lecture 1 Agent</p>
                    <p style={{ fontSize: 8, color: '#888' }}>Answers only from: Lecture 1</p>
                  </div>
                  <div className="flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', fontSize: 8, fontWeight: 700, color: '#16a34a' }}>
                    <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse inline-block" />Live
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-full px-3 py-2" style={{ background: '#f5f5f5', border: '1px solid #e5e5e5' }}>
                  <span style={{ flex: 1, fontSize: 10, color: '#aaa' }}>Ask about this lecture…</span>
                  <i className="fas fa-microphone" style={{ fontSize: 10, color: '#aaa' }} />
                  <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ background: '#065fd4' }}>
                    <i className="fas fa-paper-plane text-white" style={{ fontSize: 8 }} />
                  </div>
                </div>
              </div>
            </div>

            {/* floating chips */}
            <div className="absolute -right-4 top-16 flex flex-col gap-2">
              {[
                { icon: 'fas fa-shield-halved', color: '#22c55e', text: 'Lecture-scoped' },
                { icon: 'fas fa-microphone',    color: '#a78bfa', text: 'Voice enabled'  },
                { icon: 'fas fa-robot',         color: '#60a5fa', text: 'Gemini AI'      },
              ].map(({ icon, color, text }) => (
                <div key={text} className="flex items-center gap-2 px-3 py-2 rounded-xl border shadow-lg backdrop-blur text-[11px] font-semibold" style={{ background: 'rgba(6,13,31,0.85)', borderColor: 'rgba(255,255,255,0.12)', color: '#e2e8f0' }}>
                  <i className={`${icon} text-[11px]`} style={{ color }} />{text}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* scroll hint */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 opacity-40">
          <span className="text-[11px]" style={{ color: '#64748b' }}>Scroll to explore</span>
          <div className="w-5 h-8 rounded-full border border-slate-600 flex items-start justify-center pt-2">
            <div className="w-1 h-2 rounded-full bg-slate-400 animate-bounce" />
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ ANIMATED COUNTERS */}
      <div ref={statsRef} style={{ background: '#0a1628', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="max-w-7xl mx-auto px-8 py-10 grid grid-cols-4 gap-0 divide-x divide-white/10">
          {STATS.map((st, i) => (
            <div key={st.label} className="flex items-center gap-4 px-8 first:pl-0 last:pr-0">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0" style={{ background: st.color + '20' }}>
                <i className={`${st.icon} text-[18px]`} style={{ color: st.color }} />
              </div>
              <div>
                <p className="text-[32px] font-black text-white leading-none tabular-nums">
                  {counters[i]}{st.suffix}
                </p>
                <p className="text-[12px] mt-1" style={{ color: '#64748b' }}>{st.label}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════════ LIVE DEMO */}
      <section id="demo" style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
        <div className="max-w-7xl mx-auto px-8 py-24 grid grid-cols-2 gap-20 items-center">
          {/* Chat mockup */}
          <div>
            <div className="bg-white rounded-3xl border shadow-xl overflow-hidden" style={{ borderColor: '#e2e8f0' }}>
              {/* header */}
              <div className="flex items-center gap-3 px-5 py-4 border-b" style={{ borderColor: '#f1f5f9' }}>
                <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0"><Image src="/agent-avatar.png" alt="AI" width={40} height={40} className="w-full h-full object-cover" /></div>
                <div className="flex-1">
                  <p className="text-[14px] font-bold" style={{ color: '#111' }}>AI Tutor — Lecture 1 Agent</p>
                  <p className="text-[11px]" style={{ color: '#888' }}>Answers only from: Introduction to Fiqh</p>
                </div>
                <div className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold" style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' }}>
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse inline-block" />AI Ready
                </div>
              </div>

              <div className="mx-4 mt-4">
                <div className="flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px]" style={{ background: '#f8fafc', color: '#888' }}>
                  <i className="fas fa-circle-check text-[10px]" style={{ color: '#065fd4' }} />
                  Agent scoped — answers only from <strong style={{ color: '#065fd4' }}>this lecture</strong>
                </div>
              </div>

              {/* messages */}
              <div className="px-4 py-4 flex flex-col gap-3" style={{ minHeight: 280 }}>
                {CHAT_DEMO.map((msg, idx) => (
                  <div key={idx} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                    style={{ opacity: idx < chatIdx ? 1 : 0, transform: idx < chatIdx ? 'translateY(0)' : 'translateY(10px)', transition: 'opacity .35s ease, transform .35s ease' }}>
                    <div className="max-w-[85%] px-4 py-3 rounded-2xl text-[13px] leading-relaxed"
                      style={msg.role === 'user'
                        ? { background: '#065fd4', color: 'white', borderBottomRightRadius: 4 }
                        : { background: '#f1f5f9', color: '#111', borderBottomLeftRadius: 4 }}>
                      {msg.text}
                    </div>
                    {'sources' in msg && msg.sources && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5 max-w-[85%]">
                        {msg.sources.map((src) => (
                          <span key={src} className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: '#eff6ff', color: '#065fd4', border: '1px solid #bfdbfe' }}>
                            <i className="fas fa-book-open text-[8px] mr-1" />{src}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {showTyping && (
                  <div className="flex items-start">
                    <div className="px-4 py-3 rounded-2xl rounded-bl-sm flex items-center gap-1.5" style={{ background: '#f1f5f9' }}>
                      {[0,1,2].map((i) => <span key={i} className="typing-dot w-1.5 h-1.5 rounded-full bg-gray-400 block" style={{ animationDelay: `${i * 0.18}s` }} />)}
                    </div>
                  </div>
                )}
              </div>

              {/* voice strip */}
              <div className="mx-4 mb-3 flex items-center gap-3 px-4 py-2.5 rounded-xl border transition-all duration-500"
                style={{ background: voiceActive ? '#fef2f2' : '#f8fafc', borderColor: voiceActive ? '#fca5a5' : '#e2e8f0' }}>
                <div className="w-2 h-2 rounded-full transition-colors duration-500" style={{ background: voiceActive ? '#ef4444' : '#d1d5db' }} />
                <div className="flex items-end gap-[2px] h-5">
                  {[3,7,12,18,14,22,16,10,20,14,8,16,24,18,12,6,14,18,10,4].map((h, i) => (
                    <div key={i} className="rounded-full transition-all duration-300"
                      style={{ width: 3, height: voiceActive ? h * 1.3 : h * 0.4, background: voiceActive ? '#ef4444' : '#d1d5db', transitionDelay: `${i * 35}ms` }} />
                  ))}
                </div>
                <span className="text-[11px] font-semibold flex-1 transition-colors duration-500" style={{ color: voiceActive ? '#dc2626' : '#9ca3af' }}>
                  {voiceActive ? 'Listening… speak now' : 'Voice mode — tap mic to speak'}
                </span>
                <i className="fas fa-microphone text-[13px] transition-colors duration-500" style={{ color: voiceActive ? '#ef4444' : '#d1d5db' }} />
              </div>

              {/* input */}
              <div className="px-4 pb-4">
                <div className="flex items-center gap-2 rounded-3xl px-4 py-2.5 border" style={{ background: '#f8fafc', borderColor: '#e2e8f0' }}>
                  <span className="flex-1 text-[13px]" style={{ color: '#aaa' }}>Ask about this lecture…</span>
                  <i className="fas fa-microphone text-[13px]" style={{ color: '#ccc' }} />
                  <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: '#065fd4' }}>
                    <i className="fas fa-paper-plane text-white text-[11px]" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right: explanation */}
          <div>
            <span className="text-[12px] font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: '#eff6ff', color: '#065fd4' }}>Live Demo</span>
            <h2 className="text-[40px] font-extrabold mt-4 mb-5 leading-tight" style={{ color: '#111' }}>
              Real Answers.<br />Real Sources.<br />Every Time.
            </h2>
            <p className="text-[16px] leading-relaxed mb-8" style={{ color: '#666' }}>
              Watch a live conversation about Islamic Jurisprudence — every AI response cites the exact topic and timestamp from the lecture. No external knowledge, no hallucinations.
            </p>
            <div className="flex flex-col gap-3">
              {[
                { icon: 'fas fa-circle-check', color: '#16a34a', text: 'Source citations on every AI response' },
                { icon: 'fas fa-microphone',   color: '#7c3aed', text: 'Voice mode for hands-free Q&A' },
                { icon: 'fas fa-shield-halved',color: '#065fd4', text: 'Cannot answer outside lecture scope' },
                { icon: 'fas fa-clock-rotate-left', color: '#d97706', text: 'Full conversation history saved per student' },
                { icon: 'fas fa-robot',        color: '#0891b2', text: 'Powered by Gemini 2.5 Flash LLM' },
              ].map(({ icon, color, text }) => (
                <div key={text} className="flex items-center gap-3 p-3 rounded-xl hover:shadow-sm transition-shadow" style={{ background: 'white', border: '1px solid #e2e8f0' }}>
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: color + '15' }}>
                    <i className={`${icon} text-[13px]`} style={{ color }} />
                  </div>
                  <span className="text-[14px] font-medium" style={{ color: '#222' }}>{text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ FEATURES */}
      <section id="features" className="py-24 px-8" style={{ background: 'white' }}>
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <span className="text-[12px] font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: '#f8fafc', color: '#065fd4', border: '1px solid #e2e8f0' }}>Platform Features</span>
            <h2 className="text-[40px] font-extrabold mt-4 mb-4" style={{ color: '#111' }}>Built for Lecture-Specific AI Tutoring</h2>
            <p className="text-[16px] max-w-2xl mx-auto" style={{ color: '#666' }}>Every feature is designed around one principle — answers must come from the lecture, not the internet.</p>
          </div>

          <div className="flex flex-col gap-20">
            {FEATURES.map((f, idx) => {
              const flip = idx % 2 !== 0;
              return (
                <div key={f.title} className={`grid grid-cols-2 gap-16 items-center ${flip ? '' : ''}`}
                  style={{ animation: `fadeInUp 0.55s ease ${idx * 0.18}s both` }}>

                  {/* visual */}
                  <div className={flip ? 'order-2' : ''}>
                    <div className="rounded-3xl p-8 border" style={{ background: f.bg + '07', borderColor: f.bg + '20' }}>
                      {idx === 0 && (
                        <div className="space-y-3">
                          {['What is the meaning of Ijma in Islam?', 'Explain Qiyas with an example', 'Difference between Fard and Wajib?'].map((q, i) => (
                            <div key={q} className="bg-white rounded-2xl p-3.5 shadow-sm border" style={{ borderColor: '#f0f0f0' }}>
                              <div className="flex items-center gap-2 mb-2">
                                <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: f.bg + '20' }}>
                                  <i className="fas fa-user text-[8px]" style={{ color: f.bg }} />
                                </div>
                                <span className="text-[12px] font-semibold" style={{ color: '#111' }}>{q}</span>
                              </div>
                              <div className="h-2 rounded-full mb-1" style={{ background: f.bg + '25', width: `${75 - i * 12}%` }} />
                              <div className="h-1.5 rounded-full" style={{ background: f.bg + '15', width: `${55 - i * 10}%` }} />
                              <div className="flex gap-1.5 mt-2">
                                <span className="text-[9px] px-2 py-0.5 rounded-full font-medium" style={{ background: '#eff6ff', color: '#065fd4', border: '1px solid #bfdbfe' }}>
                                  <i className="fas fa-book-open mr-0.5 text-[7px]" />Topic: Islamic Law
                                </span>
                                <span className="text-[9px] px-2 py-0.5 rounded-full font-medium" style={{ background: '#eff6ff', color: '#065fd4', border: '1px solid #bfdbfe' }}>
                                  Lecture 1 · 0{3 + i}:{10 + i * 15}
                                </span>
                              </div>
                            </div>
                          ))}
                          <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-semibold border" style={{ background: f.bg + '10', borderColor: f.bg + '30', color: f.bg }}>
                            <i className="fas fa-shield-halved text-[10px]" />Scoped to Lecture 1 only — internet access blocked
                          </div>
                        </div>
                      )}
                      {idx === 1 && (
                        <div className="space-y-4">
                          <div className="flex items-center justify-center gap-[5px] py-4">
                            {[4,9,16,22,18,26,20,14,24,18,11,19,28,22,15,9,17,21,13,7].map((h, i) => (
                              <div key={i} className="rounded-full waveform-bar" style={{ width: 5, height: h * 1.9, background: f.bg, animationDelay: `${i * 0.05}s` }} />
                            ))}
                          </div>
                          <div className="bg-white rounded-2xl p-4 shadow-sm border flex items-center gap-3" style={{ borderColor: '#f0f0f0' }}>
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: f.bg + '15' }}>
                              <i className="fas fa-volume-high text-[16px]" style={{ color: f.bg }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] font-semibold" style={{ color: '#111' }}>AI is speaking…</p>
                              <p className="text-[11px] truncate" style={{ color: '#888' }}>Fiqh refers to Islamic jurisprudence — the human understanding of Sharia derived from…</p>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="bg-white rounded-xl p-3 border text-center shadow-sm" style={{ borderColor: '#f0f0f0' }}>
                              <i className="fas fa-keyboard text-[20px] mb-1 block" style={{ color: '#065fd4' }} />
                              <p className="text-[11px] font-bold" style={{ color: '#111' }}>Text Mode</p>
                              <p className="text-[9px]" style={{ color: '#888' }}>All browsers</p>
                            </div>
                            <div className="rounded-xl p-3 border text-center shadow-sm" style={{ background: f.bg + '10', borderColor: f.bg + '30' }}>
                              <i className="fas fa-microphone text-[20px] mb-1 block" style={{ color: f.bg }} />
                              <p className="text-[11px] font-bold" style={{ color: '#111' }}>Voice Mode</p>
                              <p className="text-[9px]" style={{ color: '#888' }}>Chrome + Edge</p>
                            </div>
                          </div>
                        </div>
                      )}
                      {idx === 2 && (
                        <div className="space-y-3">
                          {[
                            { label: 'Total Students',   val: '24',  icon: 'fas fa-user-graduate', color: '#065fd4' },
                            { label: 'Questions Asked',  val: '187', icon: 'fas fa-comments',       color: '#16a34a' },
                            { label: 'Active AI Agents', val: '3',   icon: 'fas fa-robot',          color: '#7c3aed' },
                          ].map((st) => (
                            <div key={st.label} className="bg-white rounded-xl px-4 py-3 shadow-sm border flex items-center gap-3" style={{ borderColor: '#f0f0f0' }}>
                              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: st.color + '15' }}>
                                <i className={`${st.icon} text-[14px]`} style={{ color: st.color }} />
                              </div>
                              <div className="flex-1">
                                <p className="text-[11px]" style={{ color: '#888' }}>{st.label}</p>
                                <p className="text-[22px] font-extrabold leading-none" style={{ color: '#111' }}>{st.val}</p>
                              </div>
                              <div className="h-10 w-16">
                                <div className="flex items-end justify-end gap-[2px] h-full">
                                  {[40,60,45,80,65,90,75].map((h, i) => (
                                    <div key={i} className="rounded-sm flex-1" style={{ height: `${h}%`, background: st.color + '40' }} />
                                  ))}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* text */}
                  <div className={flip ? 'order-1' : ''}>
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5 shadow-md" style={{ background: f.bg }}>
                      <i className={`${f.icon} text-white text-[20px]`} />
                    </div>
                    <h3 className="text-[30px] font-extrabold mb-4 leading-tight" style={{ color: '#111' }}>{f.title}</h3>
                    <p className="text-[15px] leading-relaxed mb-6" style={{ color: '#666' }}>{f.body}</p>
                    <ul className="space-y-2.5">
                      {f.points.map((p) => (
                        <li key={p} className="flex items-start gap-2.5 text-[14px]" style={{ color: '#333' }}>
                          <i className="fas fa-check-circle text-[13px] mt-0.5 shrink-0" style={{ color: f.bg }} />{p}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ WHY COMPARISON */}
      <section style={{ background: '#0a1628', padding: '96px 0' }}>
        <div className="max-w-5xl mx-auto px-8">
          <div className="text-center mb-12">
            <span className="text-[12px] font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: 'rgba(6,95,212,0.15)', color: '#60a5fa', border: '1px solid rgba(6,95,212,0.3)' }}>Why AskAITutor</span>
            <h2 className="text-[38px] font-extrabold text-white mt-4 mb-3">AI Tutor vs Traditional Studying</h2>
            <p className="text-[15px]" style={{ color: '#64748b' }}>See why lecture-scoped RAG beats general AI assistants for course learning.</p>
          </div>
          <div className="rounded-2xl overflow-hidden border border-white/10">
            <div className="grid grid-cols-3 text-[12px] font-bold uppercase tracking-widest px-6 py-3.5 border-b border-white/10" style={{ background: 'rgba(255,255,255,0.04)', color: '#64748b' }}>
              <div>Aspect</div>
              <div className="text-center" style={{ color: '#60a5fa' }}>AskAITutor</div>
              <div className="text-center">Traditional / General AI</div>
            </div>
            {WHY_ROWS.map((row, i) => (
              <div key={row.aspect} className="grid grid-cols-3 items-center px-6 py-4 border-b border-white/[0.06] last:border-0" style={{ background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                <span className="text-[13px] font-semibold" style={{ color: '#94a3b8' }}>{row.aspect}</span>
                <div className="flex items-center justify-center gap-2">
                  <i className="fas fa-check-circle text-[12px]" style={{ color: '#22c55e' }} />
                  <span className="text-[13px] font-semibold" style={{ color: '#e2e8f0' }}>{row.ai}</span>
                </div>
                <div className="flex items-center justify-center gap-2">
                  <i className="fas fa-xmark text-[12px]" style={{ color: '#ef4444' }} />
                  <span className="text-[13px]" style={{ color: '#64748b' }}>{row.old}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ HOW IT WORKS */}
      <section id="how" className="py-24 px-8" style={{ background: '#f8fafc' }}>
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <span className="text-[12px] font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: 'white', color: '#065fd4', border: '1px solid #e2e8f0' }}>How It Works</span>
            <h2 className="text-[40px] font-extrabold mt-4 mb-3" style={{ color: '#111' }}>From Lecture to Answer in 4 Steps</h2>
            <p className="text-[16px] max-w-xl mx-auto" style={{ color: '#666' }}>No complex setup. Open a lecture, ask your question, get a sourced answer.</p>
          </div>
          <div className="grid grid-cols-4 gap-6 relative">
            <div className="absolute top-10 left-[12.5%] right-[12.5%] h-px hidden md:block" style={{ background: 'linear-gradient(90deg, #065fd4, #7c3aed, #065fd4)' }} />
            {[
              { num: '01', icon: 'fas fa-play-circle',   title: 'Watch the Lecture',   body: 'Open any AI-ready lecture from the course page and watch it in the embedded YouTube player.',              col: '#065fd4' },
              { num: '02', icon: 'fas fa-comments',       title: 'Open AI Tutor',       body: 'Click "Ask AI Tutor" at the bottom. The chat drawer slides up, scoped to that lecture only.',            col: '#7c3aed' },
              { num: '03', icon: 'fas fa-microphone',     title: 'Ask by Text or Voice', body: 'Type your question or switch to voice mode. Speak naturally — auto-sends after 1.5 s of silence.',   col: '#059669' },
              { num: '04', icon: 'fas fa-circle-check',  title: 'Get Sourced Answers', body: 'Every response cites the exact topic and timestamp from the lecture dataset — fully traceable.',          col: '#d97706' },
            ].map((step, i) => (
              <div key={step.num} className="relative bg-white rounded-2xl border p-6 shadow-sm hover:shadow-md transition-shadow"
                style={{ borderColor: '#e2e8f0', animation: `fadeInUp 0.45s ease ${i * 0.15}s both` }}>
                <div className="absolute -top-3.5 left-5 w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-black text-white shadow-md" style={{ background: step.col }}>{step.num}</div>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center mt-3 mb-4" style={{ background: step.col + '15' }}>
                  <i className={`${step.icon} text-[18px]`} style={{ color: step.col }} />
                </div>
                <h3 className="text-[15px] font-bold mb-2" style={{ color: '#111' }}>{step.title}</h3>
                <p className="text-[13px] leading-relaxed" style={{ color: '#666' }}>{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ TESTIMONIALS */}
      <section className="py-24 px-8" style={{ background: 'white', borderTop: '1px solid #f0f0f0' }}>
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <span className="text-[12px] font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: '#f8fafc', color: '#065fd4', border: '1px solid #e2e8f0' }}>Student Feedback</span>
            <h2 className="text-[38px] font-extrabold mt-4 mb-3" style={{ color: '#111' }}>What Students Are Saying</h2>
            <p className="text-[15px] max-w-lg mx-auto" style={{ color: '#666' }}>Real feedback from students and instructors using AskAITutor.</p>
          </div>
          <div className="grid grid-cols-3 gap-6">
            {TESTIMONIALS.map((t, i) => (
              <div key={t.name} className="rounded-2xl p-6 border shadow-sm hover:shadow-md transition-shadow"
                style={{ background: '#f8fafc', borderColor: '#e2e8f0', animation: `fadeInUp 0.45s ease ${i * 0.15}s both` }}>
                <div className="flex gap-1 mb-4">
                  {[0,1,2,3,4].map((s) => <i key={s} className="fas fa-star text-[13px]" style={{ color: '#f59e0b' }} />)}
                </div>
                <p className="text-[14px] leading-relaxed mb-5" style={{ color: '#444' }}>"{t.quote}"</p>
                <div className="flex items-center gap-3 pt-4 border-t" style={{ borderColor: '#e2e8f0' }}>
                  <div className="relative shrink-0">
                    <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-[12px] font-bold" style={{ background: t.color }}>{t.avatar}</div>
                    <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: 'white', border: '1.5px solid #f3f4f6' }}>
                      <i className={`fas ${t.gender === 'f' ? 'fa-venus' : 'fa-mars'} text-[8px]`} style={{ color: t.gender === 'f' ? '#ec4899' : '#3b82f6' }} />
                    </div>
                  </div>
                  <div>
                    <p className="text-[13px] font-bold" style={{ color: '#111' }}>{t.name}</p>
                    <p className="text-[11px]" style={{ color: '#888' }}>{t.role}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ FAQ */}
      <section id="faq" className="py-24 px-8" style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0' }}>
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-14">
            <span className="text-[12px] font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: 'white', color: '#065fd4', border: '1px solid #e2e8f0' }}>FAQ</span>
            <h2 className="text-[38px] font-extrabold mt-4 mb-3" style={{ color: '#111' }}>Frequently Asked Questions</h2>
            <p className="text-[15px]" style={{ color: '#666' }}>Everything you need to know before getting started.</p>
          </div>
          <div className="space-y-3">
            {FAQS.map((faq, i) => (
              <div key={i} className="bg-white rounded-2xl border overflow-hidden shadow-sm" style={{ borderColor: openFaq === i ? '#065fd4' : '#e2e8f0', transition: 'border-color .2s' }}>
                <button className="w-full flex items-center justify-between px-6 py-4 text-left gap-4 hover:bg-slate-50 transition-colors" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                  <span className="text-[14px] font-semibold" style={{ color: '#111' }}>{faq.q}</span>
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-all duration-200" style={{ background: openFaq === i ? '#065fd4' : '#f0f0f0', transform: openFaq === i ? 'rotate(45deg)' : 'rotate(0deg)' }}>
                    <i className="fas fa-plus text-[11px]" style={{ color: openFaq === i ? 'white' : '#888' }} />
                  </div>
                </button>
                {openFaq === i && (
                  <div className="px-6 pb-5 border-t" style={{ borderColor: '#f0f0f0' }}>
                    <p className="text-[14px] leading-relaxed mt-4" style={{ color: '#555' }}>{faq.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ TECH */}
      <section style={{ background: 'white', borderTop: '1px solid #f0f0f0', padding: '80px 0' }}>
        <div className="max-w-6xl mx-auto px-8">
          <div className="text-center mb-12">
            <span className="text-[12px] font-bold uppercase tracking-widest px-3 py-1 rounded-full" style={{ background: '#f8fafc', color: '#065fd4', border: '1px solid #e2e8f0' }}>Technology</span>
            <h2 className="text-[34px] font-extrabold mt-4 mb-3" style={{ color: '#111' }}>Built on Production-Grade AI Infrastructure</h2>
          </div>
          <div className="grid grid-cols-3 gap-5">
            {[
              { icon: 'fas fa-brain',           label: 'Gemini AI',        sub: 'Powers both embeddings and LLM response generation via Gemini 2.5 Flash',  color: '#065fd4' },
              { icon: 'fas fa-database',         label: 'pgvector',         sub: 'PostgreSQL vector extension for cosine similarity search across 3072-dim embeddings',  color: '#7c3aed' },
              { icon: 'fas fa-diagram-project',  label: 'RAG Pipeline',     sub: 'Retrieval-augmented generation — every answer is sourced, not invented',    color: '#059669' },
              { icon: 'fab fa-node-js',          label: 'Node.js + Apollo', sub: 'GraphQL API with Apollo Server — type-safe, real-time, and scalable',       color: '#d97706' },
              { icon: 'fas fa-layer-group',      label: 'Next.js 14',       sub: 'App Router frontend with server components, streaming, and TypeScript',      color: '#0891b2' },
              { icon: 'fas fa-file-excel',       label: 'Excel Pipeline',   sub: 'Admin uploads .xlsx datasets; system auto-embeds all Q&A rows into pgvector', color: '#16a34a' },
            ].map((t, idx) => (
              <div key={t.label} className="flex items-center gap-5 p-6 rounded-2xl border hover:border-[#065fd4] hover:shadow-md transition-all cursor-default"
                style={{ borderColor: '#e2e8f0', animation: `fadeInUp 0.45s ease ${idx * 0.08}s both` }}>
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center shrink-0" style={{ background: t.color + '12' }}>
                  <i className={`${t.icon} text-[28px]`} style={{ color: t.color }} />
                </div>
                <div>
                  <p className="text-[16px] font-bold mb-1" style={{ color: '#111' }}>{t.label}</p>
                  <p className="text-[13px] leading-relaxed" style={{ color: '#666' }}>{t.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ CTA */}
      <section className="py-28 px-8" style={{ background: 'linear-gradient(140deg,#060d1f 0%,#0d1f45 50%,#060d1f 100%)', position: 'relative', overflow: 'hidden' }}>
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle,#fff 1px,transparent 1px)', backgroundSize: '36px 36px' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full opacity-[0.08] blur-3xl pointer-events-none" style={{ background: '#065fd4' }} />
        <div className="relative max-w-3xl mx-auto text-center">
          <div className="w-20 h-20 rounded-3xl mx-auto mb-8 flex items-center justify-center shadow-2xl" style={{ background: 'linear-gradient(135deg,#065fd4,#1a7fe8)' }}>
            <i className="fas fa-robot text-white text-3xl" />
          </div>
          <h2 className="text-[46px] font-black text-white mb-5 leading-tight">Ready to Learn Smarter?</h2>
          <p className="text-[17px] mb-10 leading-relaxed" style={{ color: '#94a3b8' }}>
            Join the platform where every question is answered from the lecture itself — not the internet. Powered by Gemini AI and RAG.
          </p>
          <div className="flex items-center justify-center gap-4">
            <Link href="/signup" className="flex items-center gap-2.5 px-10 py-4 text-[15px] font-bold text-white rounded-2xl shadow-2xl hover:scale-105 transition-transform"
              style={{ background: 'linear-gradient(135deg,#065fd4,#1a7fe8)' }}>
              <i className="fas fa-graduation-cap" /> Create Free Account
            </Link>
            <Link href="/login" className="flex items-center gap-2.5 px-8 py-4 text-[15px] font-semibold rounded-2xl border hover:bg-white/10 transition-colors"
              style={{ color: '#94a3b8', borderColor: '#334155' }}>
              Already have an account?
            </Link>
          </div>
          <p className="text-[12px] mt-6" style={{ color: '#475569' }}>
            <i className="fas fa-lock text-[10px] mr-1" />No credit card required · Lecture-scoped AI · Zero hallucinations
          </p>
        </div>
      </section>

      {/* ══════════════════════════════════════════ FOOTER */}
      <footer style={{ background: '#060d1f', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <div className="max-w-7xl mx-auto px-8 py-10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: '#065fd4' }}>
              <i className="fas fa-robot text-white text-[13px]" />
            </div>
            <div>
              <p className="text-[15px] font-extrabold text-white">AskAI<span style={{ color: '#60a5fa' }}>Tutor</span></p>
              <p className="text-[10px]" style={{ color: '#475569' }}>Lecture-scoped AI Tutoring Platform</p>
            </div>
          </div>
          <p className="text-[12px]" style={{ color: '#475569' }}>Built with Gemini 2.5 Flash · pgvector · Next.js 14 · Apollo GraphQL</p>
          <div className="flex items-center gap-6 text-[13px]">
            <Link href="/login"  className="hover:text-white transition-colors" style={{ color: '#64748b' }}>Sign In</Link>
            <Link href="/signup" className="hover:text-white transition-colors" style={{ color: '#64748b' }}>Sign Up</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
