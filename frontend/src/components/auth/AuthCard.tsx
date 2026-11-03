import { ReactNode } from 'react';
import { Logo } from '@/components/ui/Logo';

const POINTS = [
  'Answers drawn only from your lecture',
  'Every answer shows its slide and timestamp',
  'Ask by typing or by speaking',
];

interface Props { children: ReactNode }

/**
 * Sign-in / sign-up frame.
 *
 * A 45/55 split, both halves full height, one hard edge between them. Nothing
 * floats, so nothing can lose its edge against the background, and no corner
 * of the screen is left empty.
 *
 * Both columns are placed on a fixed margin rather than centred in their half:
 * a 400px column centred inside a 1000px half drifts to the middle of the
 * screen and reads as adrift, which is what an earlier version did.
 *
 * Below md the dark half is dropped and the form takes the screen.
 */
export const AuthCard = ({ children }: Props) => (
  <div className="min-h-screen grid md:grid-cols-[40fr_60fr]">

    {/* --ink-soft, the same shade as the header and the dark cards on the
        profile and activity pages. This panel was the only dark surface still
        on the deeper --ink, so signing in looked like a different product
        from the one you land in. */}
    <aside className="hidden md:flex flex-col justify-between px-12 lg:px-16 py-14" style={{ background: 'var(--ink-soft)' }}>
      <Logo variant="dark" className="h-10 w-auto" />

      <div className="max-w-[360px]">
        <h1 className="text-h1 font-semibold text-white mb-4">
          Ask your lecture anything
        </h1>
        <p className="text-body mb-8" style={{ color: '#a7b3ad' }}>
          A tutor for one lecture at a time. It answers from what your
          instructor taught, and shows you where the answer came from.
        </p>
        <ul className="flex flex-col gap-3.5">
          {POINTS.map(p => (
            <li key={p} className="flex items-start gap-3">
              <i className="fas fa-check text-caption mt-[5px] shrink-0" style={{ color: 'var(--accent-dim)' }} />
              <span className="text-label" style={{ color: '#d3ded8' }}>{p}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* #7b8781 measured 3.69:1 against the lighter panel, under the 4.5:1
          needed for small text. #94a09a is 5.09:1 and reads the same. */}
      <div className="flex items-center justify-between text-caption" style={{ color: '#94a09a' }}>
        <span>© 2026 AskAI Tutor</span>
        <div className="flex gap-5">
          <a href="#" className="transition-colors hover:text-white">Privacy</a>
          <a href="#" className="transition-colors hover:text-white">Terms</a>
        </div>
      </div>
    </aside>

    <main className="flex items-center bg-[var(--surface)] px-6 sm:px-10 lg:pl-16 lg:pr-12 py-14">
      <div className="auth-dark w-full max-w-[500px] mx-auto lg:mx-0 bg-white border border-[var(--border)] rounded-card px-7 py-9 sm:px-10 sm:py-10">
        {children}
      </div>
    </main>

  </div>
);
