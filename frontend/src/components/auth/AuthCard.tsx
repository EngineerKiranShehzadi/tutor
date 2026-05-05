import { ReactNode } from 'react';

interface Props { children: ReactNode }

export const AuthCard = ({ children }: Props) => (
  <div
    className="min-h-screen flex items-center justify-center px-4 py-12 relative overflow-hidden"
    style={{ background: 'linear-gradient(140deg,#060d1f 0%,#0d1f45 45%,#060d1f 100%)' }}
  >
    {/* dot pattern */}
    <div className="absolute inset-0 pointer-events-none opacity-[0.03]"
      style={{ backgroundImage: 'radial-gradient(circle,#fff 1px,transparent 1px)', backgroundSize: '38px 38px' }} />
    {/* glow blobs */}
    <div className="absolute top-1/3 -left-24 w-[500px] h-[500px] rounded-full opacity-[0.08] blur-3xl pointer-events-none"
      style={{ background: '#065fd4' }} />
    <div className="absolute bottom-1/4 -right-16 w-[350px] h-[350px] rounded-full opacity-[0.05] blur-3xl pointer-events-none"
      style={{ background: '#7c3aed' }} />

    <div className="auth-dark relative w-full max-w-[420px] rounded-2xl p-10"
      style={{
        background: '#ffffff',
        boxShadow: '0 40px 80px rgba(0,0,0,0.55)',
      }}
    >
      {/* Logo */}
      <div className="flex items-center justify-center gap-2.5 mb-7">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shadow-lg"
          style={{ background: 'linear-gradient(135deg,#065fd4,#1a7fe8)' }}>
          <i className="fas fa-robot text-white text-base" />
        </div>
        <span className="text-[22px] font-extrabold" style={{ color: '#0f0f0f' }}>
          AskAI<em className="not-italic" style={{ color: '#065fd4' }}>Tutor</em>
        </span>
      </div>

      {children}
    </div>
  </div>
);
