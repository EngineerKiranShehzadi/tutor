import Image from 'next/image';

export const TypingIndicator = () => (
  <div className="flex gap-2 items-end">
    <div className="w-[26px] h-[26px] rounded-lg overflow-hidden shrink-0">
      <Image src="/agent-avatar.png" alt="AI Tutor" width={26} height={26} className="object-cover" />
    </div>
    <div className="flex gap-1 px-3.5 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-2xl rounded-bl-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--muted2)] typing-dot" />
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--muted2)] typing-dot" />
      <span className="w-1.5 h-1.5 rounded-full bg-[var(--muted2)] typing-dot" />
    </div>
  </div>
);
