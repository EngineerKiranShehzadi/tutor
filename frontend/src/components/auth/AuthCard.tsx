import { ReactNode } from 'react';

interface Props { children: ReactNode }

export const AuthCard = ({ children }: Props) => (
  <div
    className="min-h-screen flex items-center justify-center px-4"
    style={{ background: 'linear-gradient(135deg,#0f0f0f 0%,#1a1a2e 50%,#16213e 100%)' }}
  >
    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[400px] p-10">
      {/* Logo */}
      <div className="flex items-center justify-center gap-2.5 mb-7">
        <div className="w-10 h-10 rounded-xl bg-[var(--red)] flex items-center justify-center">
          <i className="fas fa-play text-white text-base" />
        </div>
        <span className="text-[22px] font-extrabold text-[var(--text)]">
          AskAI<em className="not-italic text-[var(--red)]">Tutor</em>
        </span>
      </div>
      {children}
    </div>
  </div>
);
