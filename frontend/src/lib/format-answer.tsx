import { Fragment, type ReactNode } from 'react';

/**
 * Renders the small Markdown subset the tutor model actually produces.
 *
 * Returns React elements, never an HTML string, so dangerouslySetInnerHTML is
 * never involved: React escapes every text node it is handed, which means
 * admin-uploaded dataset content and model output cannot become markup. This
 * matches the approach already used for the greeting in hooks/useChat.ts.
 *
 * Recognised, and nothing else:
 *   **bold**            -> <strong>
 *   `code`              -> <code>
 *   "- x" / "* x"       -> <ul><li>
 *   "1. x" / "1) x"     -> <ol><li>
 *   blank line          -> paragraph break
 * Anything unrecognised is printed exactly as written.
 */

// Split on bold and code spans while keeping the delimiters (capturing group).
const INLINE_TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

// A bullet needs whitespace after the marker, so "**bold**" at the start of a
// line is not mistaken for a bullet.
const BULLET  = /^\s*[-*]\s+(.*)$/;
const NUMBER  = /^\s*\d+[.)]\s+(.*)$/;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(INLINE_TOKEN)
    .filter((part) => part !== '')
    .map((part, i) => {
      const key = keyPrefix + '-' + i;
      if (part.length >= 5 && part.startsWith('**') && part.endsWith('**')) {
        return <strong key={key}>{part.slice(2, -2)}</strong>;
      }
      if (part.length >= 3 && part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={key} className="px-1 py-0.5 rounded bg-black/5 font-mono text-[0.9em]">
            {part.slice(1, -1)}
          </code>
        );
      }
      return <Fragment key={key}>{part}</Fragment>;
    });
}

export function renderAnswer(raw: string): ReactNode {
  const lines = (raw ?? '').split(/\r?\n/);
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let n = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const id = 'p' + n++;
    blocks.push(
      <p key={id} className="whitespace-pre-wrap break-words">
        {inline(paragraph.join('\n'), id)}
      </p>
    );
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const id = 'l' + n++;
    const items = list.items.map((item, i) => (
      <li key={i} className="break-words">{inline(item, id + '-' + i)}</li>
    ));
    blocks.push(
      list.ordered
        ? <ol key={id} className="list-decimal pl-5 space-y-1">{items}</ol>
        : <ul key={id} className="list-disc pl-5 space-y-1">{items}</ul>
    );
    list = null;
  };

  for (const line of lines) {
    const bullet = BULLET.exec(line);
    const number = bullet ? null : NUMBER.exec(line);

    if (bullet || number) {
      flushParagraph();
      const ordered = number !== null;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? number)![1]);
      continue;
    }

    if (line.trim() === '') {
      flushList();
      flushParagraph();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushList();
  flushParagraph();

  return <div className="space-y-2">{blocks}</div>;
}
