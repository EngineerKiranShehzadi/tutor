/**
 * Shared text roles, so the same kind of text is written once.
 *
 * Anything that names a value is a field label: a table column heading, the
 * caption above a figure, the term in a definition list. They were each
 * spelled out at their own call site, which is how five of them ended up at
 * the same size and colour but a lighter weight than the table headings they
 * were supposed to match.
 *
 * The Team page's column headings are the reference.
 */
export const fieldLabel = 'text-caption font-medium text-[var(--muted)]';
