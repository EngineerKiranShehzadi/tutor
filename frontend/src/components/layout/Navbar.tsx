'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

interface Props {
  searchValue?: string;
}

export const Navbar = ({ searchValue = '' }: Props) => {
  const { user, logout } = useAuth();
  const router = useRouter();
  const [search, setSearch] = useState(searchValue);
  const initials = user?.name?.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() ?? 'U';

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-[var(--border)] flex items-center px-4 h-14 gap-2">
      {/* Logo */}
      <Link href="/courses" className="flex items-center gap-1.5 mr-2 text-decoration-none shrink-0">
        <div className="w-8 h-8 rounded-lg bg-[var(--red)] flex items-center justify-center">
          <i className="fas fa-play text-white text-xs" />
        </div>
        <span className="text-[17px] font-extrabold text-[var(--text)]">
          AskAI<em className="not-italic text-[var(--red)]">Tutor</em>
        </span>
      </Link>

      {/* Search */}
      <div className="flex flex-1 max-w-[560px] mx-auto">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && router.push(`/courses?q=${search}`)}
          placeholder="Search lectures..."
          className="flex-1 px-4 py-2 text-sm border-[1.5px] border-r-0 border-[var(--border)] rounded-l-full outline-none focus:border-[var(--accent)] bg-white"
        />
        <button className="px-4 bg-[var(--surface)] border-[1.5px] border-[var(--border)] border-l-0 rounded-r-full text-[var(--muted)] hover:bg-gray-200 transition-colors">
          <i className="fas fa-search text-sm" />
        </button>
      </div>

      {/* Right */}
      <div className="flex items-center gap-3 ml-2">
        <button className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-[var(--surface)] transition-colors text-[var(--text)]">
          <i className="fas fa-bell text-[17px]" />
        </button>
        <button
          onClick={logout}
          title="Sign out"
          className="w-[34px] h-[34px] rounded-full bg-[var(--red)] flex items-center justify-center text-white text-[13px] font-bold hover:bg-[var(--red2)] transition-colors"
        >
          {initials}
        </button>
      </div>
    </nav>
  );
};
