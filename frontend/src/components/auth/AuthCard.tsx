import { ReactNode } from 'react';
import { Logo } from '@/components/ui/Logo';

const FEATURES = [
  'Interactive AI-powered tutoring',
  'Real-time Q&A on lecture content',
  '24/7 AskAI learning support',
];

// Circular dots — varied sizes and opacities for depth
const DOTS = [
  { top: '7%',  left: '6%',   size: 3,   opacity: 0.55, glow: true  },
  { top: '19%', left: '14%',  size: 1.5, opacity: 0.28, glow: false },
  { top: '43%', left: '4%',   size: 2,   opacity: 0.22, glow: false },
  { top: '68%', left: '7%',   size: 3.5, opacity: 0.45, glow: true  },
  { top: '82%', left: '19%',  size: 1.5, opacity: 0.2,  glow: false },
  { top: '91%', left: '38%',  size: 2,   opacity: 0.18, glow: false },
  { top: '5%',  left: '43%',  size: 1.5, opacity: 0.18, glow: false },
  { top: '8%',  right: '8%',  size: 3,   opacity: 0.5,  glow: true  },
  { top: '28%', right: '5%',  size: 1.5, opacity: 0.22, glow: false },
  { top: '50%', right: '10%', size: 3.5, opacity: 0.4,  glow: true  },
  { top: '73%', right: '16%', size: 2,   opacity: 0.22, glow: false },
  { top: '88%', right: '6%',  size: 3,   opacity: 0.38, glow: true  },
  { top: '22%', right: '21%', size: 1.5, opacity: 0.15, glow: false },
  { top: '60%', right: '30%', size: 2,   opacity: 0.16, glow: false },
];

// Tiny plus / cross star accents
const STARS = [
  { top: '16%', left: '9%',   size: 7,  opacity: 0.3  },
  { top: '60%', left: '11%',  size: 5,  opacity: 0.22 },
  { top: '78%', left: '28%',  size: 6,  opacity: 0.2  },
  { top: '12%', right: '12%', size: 7,  opacity: 0.28 },
  { top: '42%', right: '6%',  size: 5,  opacity: 0.2  },
  { top: '84%', right: '22%', size: 6,  opacity: 0.22 },
];

interface Props { children: ReactNode }

export const AuthCard = ({ children }: Props) => (
  <div className="min-h-screen flex items-center justify-center p-4 sm:p-8 relative overflow-hidden">

    {/* ── 1. Deep navy/blue base gradient ── */}
    <div className="absolute inset-0"
      style={{ background: 'linear-gradient(140deg, #05081c 0%, #09122e 40%, #0d1e4a 65%, #060d1c 100%)' }} />

    {/* ── 2. Soft grid — blue-tinted, very low opacity ── */}
    <div className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage:
          'linear-gradient(rgba(77,159,240,0.04) 1px, transparent 1px),' +
          'linear-gradient(90deg, rgba(77,159,240,0.04) 1px, transparent 1px)',
        backgroundSize: '64px 64px',
      }} />

    {/* ── 3a. Ambient corner orbs ── */}
    <div className="absolute -top-[15%] -left-[8%] w-[580px] h-[580px] rounded-full blur-[150px] pointer-events-none"
      style={{ background: 'radial-gradient(circle, rgba(6,95,212,0.22) 0%, transparent 70%)' }} />
    <div className="absolute -bottom-[15%] -right-[8%] w-[500px] h-[500px] rounded-full blur-[140px] pointer-events-none"
      style={{ background: 'radial-gradient(circle, rgba(109,40,217,0.18) 0%, transparent 70%)' }} />

    {/* ── 3b. Wide soft glow centered behind the card ── */}
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[920px] h-[580px] pointer-events-none"
      style={{
        background: 'radial-gradient(ellipse 55% 50% at 50% 50%, rgba(6,95,212,0.2) 0%, rgba(6,95,212,0.07) 45%, transparent 70%)',
        filter: 'blur(40px)',
      }} />

    {/* ── 3c. Tight inner glow — lifts card off the dark bg ── */}
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[640px] h-[420px] pointer-events-none"
      style={{
        background: 'radial-gradient(ellipse 60% 55% at 50% 50%, rgba(30,120,255,0.13) 0%, transparent 65%)',
        filter: 'blur(24px)',
      }} />

    {/* ── 4. Dot particles ── */}
    {DOTS.map((d, i) => (
      <div
        key={i}
        className="absolute rounded-full pointer-events-none"
        style={{
          width:  d.size,
          height: d.size,
          top:    d.top,
          left:   (d as Record<string, unknown>).left as string | undefined,
          right:  (d as Record<string, unknown>).right as string | undefined,
          opacity: d.opacity,
          background: d.glow
            ? 'radial-gradient(circle, #a8d4ff 0%, #4d9ff0 55%, transparent 100%)'
            : '#4d9ff0',
          boxShadow: d.glow ? `0 0 ${d.size * 4}px 1px rgba(77,159,240,0.7)` : 'none',
        }}
      />
    ))}

    {/* ── 4. Plus / cross star accents ── */}
    {STARS.map((s, i) => (
      <div
        key={`star-${i}`}
        className="absolute pointer-events-none"
        style={{
          top:   s.top,
          left:  (s as Record<string, unknown>).left as string | undefined,
          right: (s as Record<string, unknown>).right as string | undefined,
          width: s.size,
          height: s.size,
          opacity: s.opacity,
        }}
      >
        {/* horizontal bar */}
        <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: 'linear-gradient(90deg, transparent, #6db8ff, transparent)', transform: 'translateY(-50%)' }} />
        {/* vertical bar */}
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'linear-gradient(180deg, transparent, #6db8ff, transparent)', transform: 'translateX(-50%)' }} />
      </div>
    ))}

    {/* ── 5. Main card — elevated with colored glow shadow ── */}
    <div
      className="relative w-full max-w-[1040px] rounded-2xl overflow-hidden flex"
      style={{
        minHeight: '620px',
        boxShadow: [
          '0 0 0 1px rgba(77,159,240,0.12)',       /* subtle blue border */
          '0 0 60px rgba(6,95,212,0.2)',            /* soft blue halo */
          '0 20px 60px rgba(0,0,0,0.55)',           /* main depth shadow */
          '0 48px 100px rgba(0,0,0,0.4)',           /* far diffuse shadow */
        ].join(', '),
      }}
    >

      {/* ── Left branding panel ── */}
      <div
        className="hidden md:flex w-[420px] shrink-0 flex-col px-10 py-10 relative overflow-hidden"
        style={{ background: 'linear-gradient(155deg, #0d1b4b 0%, #112060 55%, #0b1535 100%)' }}
      >
        {/* inner glow */}
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at 30% 20%, rgba(6,95,212,0.2) 0%, transparent 60%)' }} />

        {/* subtle grid inside panel */}
        <div className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(77,159,240,0.04) 1px, transparent 1px),' +
              'linear-gradient(90deg, rgba(77,159,240,0.04) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }} />

        <Logo variant="dark" className="relative mb-auto h-11 w-auto" />

        {/* Copy */}
        <div className="relative my-auto py-8">
          <h1 className="text-[38px] font-extrabold text-white leading-[1.15] mb-4">
            Student<br/>
            <span style={{ color: '#60A5FA' }}>Learning Portal</span>
          </h1>
          <p className="text-[15px] leading-relaxed mb-8 max-w-[300px]" style={{ color: '#B8C7E8' }}>
            Your AI-powered hub for academic resources, interactive lectures, and personalised learning.
          </p>
          <div className="flex flex-col gap-4">
            {FEATURES.map(f => (
              <div key={f} className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full border border-[#1a5bb0] bg-[#0a1f4d] flex items-center justify-center shrink-0">
                  <i className="fas fa-check text-[12px]" style={{ color: '#38BDF8' }} />
                </div>
                <span className="text-[14px] font-medium" style={{ color: '#D6E4FF' }}>{f}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="relative flex items-center justify-between text-[12px]" style={{ color: 'rgba(184,199,232,0.65)' }}>
          <span>© 2026 AskAI Tutor</span>
          <div className="flex gap-3">
            <a href="#" className="transition-colors hover:text-[#D6E4FF]">Privacy</a>
            <a href="#" className="transition-colors hover:text-[#D6E4FF]">Terms</a>
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex-1 bg-white flex items-center justify-center px-10 py-10">
        <div className="auth-dark w-full max-w-[400px]">
          {children}
        </div>
      </div>

    </div>
  </div>
);
