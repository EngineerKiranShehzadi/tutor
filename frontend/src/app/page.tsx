'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/ui/Logo';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/cn';

/**
 * Landing page.
 *
 * Rewritten onto the product theme, and with every claim checked against the
 * code. What the previous version stated and this one does not:
 *
 *   "Zero Hallucinations"            — not a thing any system can promise.
 *   "3072-dim embeddings"            — the vectors are 1024-dimension; the
 *                                      column is vector(1024).
 *   "never queries the internet"     — the language model is a hosted API, so
 *                                      it is reached over the internet. What
 *                                      is true is narrower and is said below:
 *                                      no web search, and the facts come from
 *                                      the lecture dataset.
 *   "Hallucination Rate: 0ms"        — a rate measured in milliseconds.
 *   Six named student testimonials   — invented people with invented quotes.
 *                                      Deleted outright; nothing replaced them,
 *                                      because there is nothing real to put
 *                                      there yet.
 *   "Total Students: 24" etc.        — a mocked admin panel with made-up
 *                                      figures presented as a screenshot.
 *
 * Nine sections became six. Design follows the rest of the product: white
 * canvas, one accent, one typeface, the shared type scale, flat surfaces with
 * 1px borders instead of gradients and drop shadows.
 */

const STEPS = [
  {
    n: '01',
    icon: 'fas fa-upload',
    title: 'Your instructor adds the lecture',
    body: 'The recorded lecture, plus a dataset of the questions and answers it covers.',
  },
  {
    n: '02',
    icon: 'fas fa-layer-group',
    title: 'The system indexes it',
    body: 'Each question and answer is split into pieces and stored as a 1024-dimension vector in PostgreSQL.',
  },
  {
    n: '03',
    icon: 'fas fa-comment-dots',
    title: 'You ask, by typing or speaking',
    body: 'Beside the video on the lecture page, so you can ask at the moment you get stuck.',
  },
  {
    n: '04',
    icon: 'fas fa-quote-right',
    title: 'You get an answer with its source',
    body: 'Every answer names the lecture topic it was drawn from, so you can go back and check it.',
  },
];

const CAPABILITIES = [
  {
    icon: 'fas fa-bullseye',
    title: 'It stays inside one lecture',
    body: 'Each tutor is bound to its own lecture\'s dataset. Ask about something that lecture never covered and it says so, rather than answering from somewhere else.',
  },
  {
    icon: 'fas fa-location-dot',
    title: 'Every answer shows where it came from',
    body: 'The topic the answer was retrieved from is shown with it. Nothing arrives without a way to trace it back to the lecture.',
  },
  {
    icon: 'fas fa-circle-check',
    title: 'It says when it is not sure',
    body: 'Before an answer reaches you it is checked against the lecture text it was built from. If it cannot be supported by that text, it is withheld instead of shown.',
  },
];

const STACK = [
  { icon: 'fas fa-database',  name: 'PostgreSQL + pgvector', body: 'Lecture content stored as 1024-dimension vectors, searched by cosine similarity' },
  { icon: 'fas fa-diagram-project', name: 'Retrieval pipeline', body: 'Vector search, then re-ranking, then answer generation from the retrieved text' },
  { icon: 'fas fa-code',      name: 'Next.js and GraphQL',   body: 'One typed API shared by the student and instructor interfaces' },
  { icon: 'fas fa-microphone',name: 'Voice in the browser',  body: 'Ask by speaking, and have the answer read back' },
];

const FAQS = [
  {
    q: 'Does the tutor search the internet for answers?',
    a: 'No. The facts in an answer are retrieved from your lecture\'s own dataset. A language model is used to put those retrieved passages into readable form — it is not asked to supply knowledge of its own, and no web search is performed. The model itself is a hosted service, so it is reached over the internet, but what it is given to work with is your lecture.',
  },
  {
    q: 'Can I ask about a different lecture?',
    a: 'No. Each tutor is scoped to exactly one lecture. Questions outside that lecture get a reply saying the answer is not in it, rather than an answer borrowed from another lecture.',
  },
  {
    q: 'What happens if my question is not covered in the lecture?',
    a: 'You are told. The tutor replies that it could not find the information in that lecture. This is deliberate — a confident wrong answer is worse than no answer when you are revising.',
  },
  {
    q: 'Does voice work in every browser?',
    a: 'Hearing the answer read back works in all current browsers. Asking by speaking uses a browser speech API available in Chrome and Edge; elsewhere the microphone button is disabled and you can type instead.',
  },
  {
    q: 'How soon can I ask about a newly added lecture?',
    a: 'Once the instructor uploads its dataset, the content is processed and indexed automatically. Until that finishes the lecture shows as not ready and cannot be asked about. You are notified when it becomes ready.',
  },
  {
    q: 'Who can see the questions I ask?',
    a: 'Your instructor can. The instructor console shows the questions asked for each lecture, which is how gaps in a lecture get found. Your password and account details are not part of that.',
  },
];

const CHAT_PREVIEW = [
  { role: 'student', text: 'What are the key elements of an effective prompt?' },
  {
    role: 'tutor',
    text: 'An effective prompt has four parts: clarity about what you want, context the model needs, constraints on scope or format, and examples to guide it.',
    source: 'Topic: Elements of Effective Prompts',
  },
  { role: 'student', text: 'Who won the cricket world cup?' },
  { role: 'tutor', text: 'I could not find this information in this lecture.', source: null },
];

function Section({ id, tint = false, children }: {
  id?: string; tint?: boolean; children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        'px-6 py-20 md:py-24 border-t border-[var(--border)]',
        tint ? 'bg-[var(--surface)]' : 'bg-white'
      )}
    >
      <div className="max-w-[1080px] mx-auto">{children}</div>
    </section>
  );
}

function Heading({ overline, title, body }: { overline: string; title: string; body?: string }) {
  return (
    <div className="max-w-[620px] mb-10">
      <p className="text-label font-semibold text-[var(--accent)] mb-2.5">{overline}</p>
      <h2 className="text-h1 md:text-[32px] font-semibold text-[var(--text)] leading-[1.2]">{title}</h2>
      {body && <p className="text-body text-[var(--muted)] mt-3.5 leading-relaxed">{body}</p>}
    </div>
  );
}

export default function LandingPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // Someone already signed in has no use for the marketing page.
  useEffect(() => {
    if (isLoading || !user) return;
    router.replace(user.role === 'ADMIN' ? '/admin/dashboard' : '/courses');
  }, [user, isLoading, router]);

  if (isLoading || user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <span className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="bg-white">

      {/* ── Header — the same dark bar as the signed-in app, so the product
             does not change identity at the door. ── */}
      <nav className="sticky top-0 z-50 bg-[var(--ink-soft)] border-b border-white/10">
        <div className="px-6 md:px-8 h-[72px] flex items-center">
          <Logo variant="dark" className="h-10 w-auto shrink-0" />
          <div className="hidden lg:flex items-center gap-7 ml-10">
            {[['#how', 'How it works'], ['#what', 'What it does'], ['#faq', 'Questions']].map(([href, label]) => (
              <a key={href} href={href} className="text-label font-medium text-white/75 hover:text-white transition-colors">
                {label}
              </a>
            ))}
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-7">
            <Link
              href="/login"
              className="text-label font-medium text-white/75 hover:text-white transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="inline-flex items-center h-9 px-4 rounded-control bg-white text-[var(--ink)] text-label font-semibold transition-colors hover:bg-[var(--accent-soft)]"
            >
              Create account
            </Link>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="px-6 pt-16 pb-20 md:pt-24 md:pb-28">
        <div className="max-w-[1080px] mx-auto grid lg:grid-cols-[minmax(0,1fr)_440px] gap-14 items-center">

          <div className="min-w-0">
            {/* The one place the type scale is exceeded, deliberately: a
                landing headline is the largest thing on the site. */}
            <h1 className="text-display md:text-[52px] font-semibold text-[var(--text)] leading-[1.08] tracking-tight">
              Ask your lecture anything
            </h1>
            <p className="text-body md:text-h3 text-[var(--muted)] mt-5 max-w-[520px] leading-relaxed">
              A tutor for one lecture at a time. It answers from what your instructor
              taught, and shows you where the answer came from.
            </p>

            <div className="flex flex-wrap items-center gap-3 mt-8">
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 h-12 px-7 rounded-control bg-[var(--accent)] text-white text-body font-semibold transition-colors hover:bg-[var(--accent-deep)]"
              >
                Create an account
                <i className="fas fa-arrow-right text-label" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center h-12 px-7 rounded-control border border-[var(--border)] text-body font-semibold text-[var(--text)] transition-colors hover:bg-[var(--surface)]"
              >
                Sign in
              </Link>
            </div>

            <ul className="flex flex-col gap-2.5 mt-10">
              {[
                'Answers drawn only from your lecture',
                'Every answer names the topic it came from',
                'Ask by typing or by speaking',
              ].map(p => (
                <li key={p} className="flex items-start gap-2.5">
                  <i className="fas fa-check text-caption text-[var(--accent)] mt-[5px] shrink-0" />
                  <span className="text-label text-[var(--muted)]">{p}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* An illustration of the interface, not a recording. The second
              exchange is the one worth showing: the tutor refusing a question
              its lecture does not cover. */}
          <div className="bg-white border border-[var(--border)] rounded-card overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)] bg-[var(--surface)]">
              <span className="w-2 h-2 rounded-full bg-[var(--accent)]" />
              <span className="text-caption font-medium text-[var(--text)]">Lecture 1 — Introduction to Prompt Engineering</span>
            </div>
            <div className="p-4 flex flex-col gap-3">
              {CHAT_PREVIEW.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'student' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[88%] rounded-card px-3.5 py-2.5',
                      m.role === 'student'
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--surface)] border border-[var(--border)]'
                    )}
                  >
                    <p className={cn('text-caption leading-relaxed', m.role === 'student' ? 'text-white' : 'text-[var(--text)]')}>
                      {m.text}
                    </p>
                    {m.source && (
                      <p className="text-[11px] text-[var(--muted)] mt-2 pt-2 border-t border-[var(--border)]">
                        <i className="fas fa-location-dot mr-1.5" />
                        {m.source}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="px-4 pb-4 text-[11px] text-[var(--muted2)]">
              An illustration of the interface.
            </p>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <Section id="how" tint>
        <Heading
          overline="How it works"
          title="From a recorded lecture to a sourced answer"
          body="Four steps, and nothing happens to a lecture until its instructor adds it."
        />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {STEPS.map(s => (
            <div key={s.n} className="bg-[var(--surface)] border border-[var(--border)] rounded-card p-5">
              <div className="flex items-center justify-between mb-4">
                <span className="w-9 h-9 rounded-control bg-[var(--accent-soft)] flex items-center justify-center">
                  <i className={cn(s.icon, 'text-label text-[var(--accent)]')} />
                </span>
                <span className="text-caption font-semibold text-[var(--muted2)] tabular-nums">{s.n}</span>
              </div>
              <h3 className="text-label font-semibold text-[var(--text)] leading-snug">{s.title}</h3>
              <p className="text-caption text-[var(--muted)] mt-2 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── What it does ── */}
      <Section id="what">
        <Heading
          overline="What it does"
          title="Built so every answer can be checked"
          body="Three things decide whether a tutor like this is worth revising from."
        />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {CAPABILITIES.map(c => (
            <div key={c.title} className="border border-[var(--border)] rounded-card p-6">
              <span className="w-10 h-10 rounded-control bg-[var(--accent-soft)] flex items-center justify-center mb-5">
                <i className={cn(c.icon, 'text-body text-[var(--accent)]')} />
              </span>
              <h3 className="text-h3 font-semibold text-[var(--text)] leading-snug">{c.title}</h3>
              <p className="text-label text-[var(--muted)] mt-3 leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── How it is built ── */}
      <Section tint>
        <Heading overline="How it is built" title="What the system is made of" />
        <div className="grid sm:grid-cols-2 gap-x-10 gap-y-6">
          {STACK.map(t => (
            <div key={t.name} className="flex items-start gap-4">
              <span className="w-9 h-9 rounded-control bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center shrink-0">
                <i className={cn(t.icon, 'text-label text-[var(--muted)]')} />
              </span>
              <div className="min-w-0">
                <p className="text-label font-semibold text-[var(--text)]">{t.name}</p>
                <p className="text-caption text-[var(--muted)] mt-1 leading-relaxed">{t.body}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Questions ── */}
      <Section id="faq">
        <Heading overline="Questions" title="Common questions" />
        <div className="border border-[var(--border)] rounded-card overflow-hidden">
          {FAQS.map((f, i) => {
            const open = openFaq === i;
            return (
              <div key={f.q} className="border-b border-[var(--border)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpenFaq(open ? null : i)}
                  aria-expanded={open}
                  className="w-full flex items-start justify-between gap-4 text-left px-5 py-4 transition-colors hover:bg-[var(--surface)]"
                >
                  <span className="text-label font-semibold text-[var(--text)]">{f.q}</span>
                  <i
                    className={cn(
                      'fas fa-chevron-down text-caption text-[var(--muted2)] mt-1 shrink-0 transition-transform',
                      open && 'rotate-180'
                    )}
                  />
                </button>
                {open && (
                  <p className="px-5 pb-5 -mt-1 text-label text-[var(--muted)] leading-relaxed max-w-[760px]">
                    {f.a}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── Footer ── */}
      {/* Same surface as the block above it, divided by a hairline. These were
          #223029 sitting directly on #15201c — two darks close enough that the
          join read as a rendering fault rather than a boundary. */}
      {/* Footer.
          Grouped into labelled columns, with each header a step brighter than
          its links so the grouping is visible instead of one flat row. Legal
          sits below a rule, separate from navigation.

          Everything here is real. No newsletter box (nothing is behind one),
          no phone number or office address, and no social icons for accounts
          that do not exist — the same reason the invented student reviews were
          deleted. The lecture attribution is here because the course material
          genuinely is someone else's work. */}
      <footer className="px-6 md:px-8 pt-14 pb-8 bg-[var(--ink-soft)]">

        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-12">

          <div>
            <Logo variant="dark" className="h-9 w-auto mb-4" />
            <p className="text-label leading-relaxed text-justify hyphens-auto" style={{ color: '#a7b3ad' }}>
              A tutor for one lecture at a time. It answers from what your
              instructor taught, and shows you where the answer came from.
            </p>
          </div>

          {/* Anchors into this page, kept apart from real destinations — they
              were listed together under "Pages", which three of the five are
              not. */}
          <div>
            <p className="text-label font-semibold text-white mb-4">On this page</p>
            <ul className="flex flex-col gap-2.5">
              {[['#how', 'How it works'], ['#what', 'What it does'], ['#faq', 'Questions']].map(([href, label]) => (
                <li key={href}>
                  <a href={href} className="text-label transition-colors hover:text-white" style={{ color: '#a7b3ad' }}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-label font-semibold text-white mb-4">Your account</p>
            <ul className="flex flex-col gap-2.5">
              <li>
                <Link href="/login" className="text-label transition-colors hover:text-white" style={{ color: '#a7b3ad' }}>
                  Sign in
                </Link>
              </li>
              <li>
                <Link href="/signup" className="text-label transition-colors hover:text-white" style={{ color: '#a7b3ad' }}>
                  Create an account
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="text-label font-semibold text-white mb-4">Lecture content</p>
            <p className="text-label leading-relaxed text-justify hyphens-auto" style={{ color: '#a7b3ad' }}>
              The course recordings this tutor answers from are the work of{' '}
              <span className="text-white">Fazal Qadir Khan Islamic Institute Pakistan</span>.
              AskAI Tutor only retrieves what is already in them.
            </p>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-white/10 flex flex-wrap items-center justify-between gap-3">
          <p className="text-label" style={{ color: '#94a09a' }}>© 2026 AskAI Tutor</p>
          <p className="text-label" style={{ color: '#94a09a' }}>
            Final year project · COMSATS University Islamabad, Lahore Campus
          </p>
        </div>
      </footer>
    </div>
  );
}
