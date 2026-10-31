// Turns the markdown an answer model produces into SAFE html for display.
//
// Why this exists. MessageBubble renders finished answers with
// dangerouslySetInnerHTML. Passing the raw answer straight in caused two
// separate problems:
//
//   1. Presentation — the model writes markdown ("* item", "**bold**"), not
//      html, so every list reached the student as literal asterisks.
//
//   2. Security — whatever the answer contained was executed by the browser
//      as real markup. Answer text is generated from uploaded dataset
//      content, so a dataset row containing a <script> tag, or an <img> with
//      an onerror attribute, would run in every student's browser. That is a
//      stored cross-site-scripting hole with the dataset upload as its entry
//      point.
//
// The order below is the whole point: EVERYTHING is escaped first and
// unconditionally, so no markup from the model or the dataset can reach the
// DOM alive. Only the small, fixed set of patterns recognised here is then
// turned back into tags. Nothing else can become html, whatever the answer
// contains.
//
// The supported subset is deliberately small — paragraphs, bulleted and
// numbered lists, bold and inline code — because that is what the answer
// prompts actually produce. It is not a general markdown parser and should
// not grow into one; if richer formatting is ever needed, bring in a
// maintained library rather than extending this.

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Inline formatting, applied only to text that has already been escaped.
// Single-asterisk italics are deliberately NOT supported: a lone '*' is how
// the model starts a bullet, and treating it as italics mangles lists.
const inline = (s: string): string =>
  s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

type ListAcc = { type: 'ul' | 'ol'; items: string[] };

const flushList = (out: string[], list: ListAcc | null): void => {
  if (!list || list.items.length === 0) return;
  out.push(`<${list.type}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.type}>`);
};

export const formatAnswerHtml = (raw: string): string => {
  const lines = escapeHtml(raw ?? '').split(/\r?\n/);
  const out: string[] = [];
  let list: ListAcc | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList(out, list);
      list = null;
      continue;
    }

    // "* item", "- item" and "• item" all mean a bullet.
    const bullet = /^[*\-•]\s+(.*)$/.exec(trimmed);
    // "1. item" and "1) item" both mean a numbered item.
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);

    if (bullet || numbered) {
      const type: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
      const text = (bullet ?? numbered)![1];
      if (!list || list.type !== type) {
        flushList(out, list);
        list = { type, items: [] };
      }
      const current = list;
      current.items.push(inline(text));
      continue;
    }

    flushList(out, list);
    list = null;
    out.push(`<p>${inline(trimmed)}</p>`);
  }

  flushList(out, list);
  return out.join('');
};
