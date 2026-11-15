'use client';
import Link from 'next/link';

interface AdminPageHeroProps {
  /** Kept so existing callers compile; the hero no longer shows an icon. */
  icon?: string;
  /** Kept so existing callers compile; the hero no longer tints its icon. */
  iconGradient?: string;
  title: string;
  subtitle: string;
  action?: React.ReactNode;
  /** A section between Admin and this page, e.g. Lectures on one lecture. */
  parent?: { label: string; href: string };
}

/**
 * The heading band every admin page opens with.
 *
 * It used to be a slate-to-indigo gradient carrying three translucent circles,
 * a 64px gradient icon tile with a white border and shadow, and an extra-bold
 * 24px title in white — none of which exist anywhere else in the product.
 *
 * The student side opens a page with a heading and one line under it, so this
 * does the same. The band is the same width as the content under it rather
 * than bleeding to the edges of the page. The title is set at the top of the scale, well clear of the
 * 17px section headings beneath it: at 20px the two were close enough that
 * nothing on the page read as a level above anything else.
 */
// No status pill beside the title. The one page that used it repeated a field
// already shown in the summary below, in a different spelling, in the one
// shape the tables had just stopped using. Removed from the hero as well as
// from that page, so it cannot quietly come back.
export function AdminPageHero({ title, subtitle, action, parent }: AdminPageHeroProps) {
  return (
    <div className="mb-7 border-b border-[var(--border)] pb-5">
      {/* The trail is how you go back up, so a page one level down needs no
          Back button of its own. */}
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-caption text-[var(--muted)]">
        <Link href="/admin/dashboard" className="hover:text-[var(--text)] transition-colors">Admin</Link>
        <i className="fas fa-chevron-right text-[9px]" aria-hidden="true" />
        {parent && (
          <>
            <Link href={parent.href} className="hover:text-[var(--text)] transition-colors">{parent.label}</Link>
            <i className="fas fa-chevron-right text-[9px]" aria-hidden="true" />
          </>
        )}
        <span className="font-medium text-[var(--text)] truncate max-w-[52ch]">{title}</span>
      </nav>

      {/* No icon beside the title. A tinted square holding a pictogram is the
          house style of every generated admin template, and it says nothing the
          heading does not: the breadcrumb already places you. */}
      <div className="mt-3 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-h1 font-semibold text-[var(--text)]">{title}</h1>
          <p className="mt-1 text-label text-[var(--muted)]">{subtitle}</p>
        </div>

        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
