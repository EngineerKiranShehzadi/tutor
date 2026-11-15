/**
 * The admin console's buttons, defined once.
 *
 * They were written out at each call site, which is how the same button came
 * to exist at two different paddings on two pages, and how a secondary action
 * ended up sharing no colour at all with the primary one beside it.
 *
 * Three roles, and the rule for choosing is what the button is next to:
 *
 *   primary   One per view: the thing you opened it to do. Navy fill.
 *   secondary Its partner in a page heading or a dialog. The same navy at a
 *             fraction of the weight, so the pair is visibly one family and
 *             the primary is still the first stop.
 *   row       Actions repeated down a table. These stay neutral on purpose:
 *             there are dozens on screen at once, and tinting every one turns
 *             the table blue and makes none of them stand out.
 */

/**
 * Two heights, and the rule is what the button does.
 *
 *   h-10  Anything that performs an action: a page heading, a dialog, a
 *         table row. Same height everywhere, so the only thing that changes
 *         between them is colour weight.
 *   h-9   Filters. They change what you are looking at rather than doing
 *         anything, and they come three at a time.
 *
 * Everything carries rounded-control, so two buttons side by side have the
 * same corner whatever state they are in.
 */
const base = 'rounded-control text-label font-semibold transition-colors disabled:opacity-50';

export const btnPrimary   = `h-10 ${base} bg-[var(--accent)] px-5 text-white hover:bg-[var(--accent-deep)]`;

// Hover only has to confirm the cursor is on the right thing, so it deepens
// the same tint by a shade. Swapping to a dark fill made every pass of the
// mouse look like a click.
export const btnSecondary = `h-10 ${base} bg-[var(--accent-soft)] px-4 text-[var(--accent)] hover:bg-[#dde6f0]`;

/**
 * A filter, which is a button that also shows which way it is set. The chosen
 * one is filled; the rest take the secondary tint, so the row is one family
 * rather than a navy button sitting among white ones.
 */
const filterBase = 'h-9 inline-flex items-center rounded-control px-3.5 text-caption font-semibold transition-colors';
export const filterOn  = `${filterBase} bg-[var(--accent)] text-white`;
export const filterOff = `${filterBase} bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[#dde6f0]`;

/**
 * A native <select> standing in a row of filters, which carries the same
 * on/off idea as the pills above.
 *
 * A bar of five dropdowns all tinted the same pale navy said nothing: every
 * control looked equally busy whether it was filtering anything or not. So a
 * select is neutral while it sits on its default, and takes the tint once it
 * is actually narrowing the list. The bar stays quiet, and the filters doing
 * something are the only coloured things in it.
 *
 * A function rather than two exports, so a call site cannot pick the tint and
 * forget to pass the condition that earns it.
 */
// No border on either state, on purpose. A native select draws its own edge,
// so a border declared on top of it stacks two edges and reads as a heavy
// outline. These are told apart by fill: white while off, tinted while on.
// `select-arrow` (globals.css) switches off the browser's own arrow and draws
// one at a position we control. Padding alone could never do it: a browser
// places the native arrow against the border edge, so padding-right moves the
// text and leaves the arrow on the border. pr-9 is the room the drawn arrow
// needs; globals.css decides how far in it sits.
const filterSelectBase = 'select-arrow h-9 rounded-control pl-3 pr-9 text-caption font-semibold transition-colors cursor-pointer border-0 focus:outline-none focus:ring-2 focus:ring-[var(--accent-dim)]';
export const filterSelect = (active: boolean): string => (active
  ? `${filterSelectBase} bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[#dde6f0]`
  : `${filterSelectBase} bg-[var(--card)] text-[var(--text)] hover:bg-[var(--surface)]`);

/**
 * A button sharing a toolbar with those selects: the same height, radius and
 * white fill, so the row lines up and nothing in it carries an outline. For
 * something that acts once and holds no state worth colouring, like Refresh.
 */
export const btnToolbar = 'h-9 inline-flex items-center rounded-control bg-[var(--card)] px-3.5 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors disabled:opacity-50';

/**
 * Neutral, and repeated down a table. Full action height: at the old padding
 * it came out 35px tall against 160px wide, which reads as a strip rather
 * than a button.
 */
export const btnRow = 'h-10 inline-flex items-center rounded-control border border-[var(--border)] px-3.5 text-caption font-semibold text-[var(--text)] hover:bg-[var(--surface)] transition-colors disabled:opacity-50';
