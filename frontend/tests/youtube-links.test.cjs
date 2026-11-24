'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');

const file = path.resolve(__dirname, '../src/lib/format-answer.tsx');
const built = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file,
  reportDiagnostics: true,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
});
const errors = (built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0, JSON.stringify(errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n'))));
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputText)(require, mod, mod.exports);
const { renderAnswer } = mod.exports;

function elements(node, type) {
  if (node == null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(child => elements(child, type));
  return [
    ...(node.type === type ? [node] : []),
    ...elements(node.props?.children, type),
  ];
}

const url = 'https://www.youtube.com/watch?v=Abc123_-xyz';

test('three numbered YouTube recommendations are direct links that open safely in a new tab', () => {
  const ids = ['Abc123_-xyz', 'mnopqrstuvw', '0123456789_'];
  const answer = 'Here are 3 English videos about zero-shot prompting:\n\n' +
    ids.map((id, i) => `${i + 1}. [Video ${i + 1}](https://www.youtube.com/watch?v=${id})`).join('\n');
  const result = renderAnswer(answer);
  assert.equal(elements(result, 'ol').length, 1);
  assert.equal(elements(result, 'li').length, 3);
  const links = elements(result, 'a');
  assert.equal(links.length, 3);
  links.forEach((link, i) => {
    assert.equal(link.props.href, `https://www.youtube.com/watch?v=${ids[i]}`);
    assert.equal(link.props.children, `Video ${i + 1}`);
    assert.equal(link.props.target, '_blank');
    assert.equal(link.props.rel, 'noopener noreferrer');
  });
});

test('titles are escaped React text, including Hindi and HTML-like content', () => {
  const result = renderAnswer(`[हिंदी <img src=x onerror=alert(1)> & zero-shot](${url})`);
  const links = elements(result, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].props.children, 'हिंदी <img src=x onerror=alert(1)> & zero-shot');
  const html = renderToStaticMarkup(result);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&amp; zero-shot/);
  assert.doesNotMatch(html, /<img\b/);
});

test('unsupported or misleading URLs remain literal and cannot become links', () => {
  const urls = [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://www.youtube.com/watch?v=Abc123_-xyz',
    'https://www.youtube.com.evil.test/watch?v=Abc123_-xyz',
    'https://www.youtube.com@evil.test/watch?v=Abc123_-xyz',
    'https://evil.test/watch?v=Abc123_-xyz',
    'https://www.youtube.com/redirect?v=Abc123_-xyz',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=Abc123_-xyz0',
    'https://www.youtube.com/watch?v=Abc123_-xy!',
    'https://www.youtube.com/watch?v=Abc123_-xyz&redirect=https://evil.test',
    'https://www.youtube.com/watch?v=Abc123_-xyz#fragment',
    '//www.youtube.com/watch?v=Abc123_-xyz',
  ];
  for (const href of urls) {
    const answer = `[Video](${href})`;
    const result = renderAnswer(answer);
    assert.equal(elements(result, 'a').length, 0, href);
    assert.equal(result.props.children[0].props.children[0].props.children, answer, href);
  }
});

test('video-link syntax inside code or bold spans stays literal', () => {
  const markdown = `[Video](${url})`;
  const result = renderAnswer('`' + markdown + '` and **' + markdown + '**');
  assert.equal(elements(result, 'a').length, 0);
  assert.equal(elements(result, 'code')[0].props.children, markdown);
  assert.equal(elements(result, 'strong')[0].props.children, markdown);
});

test('existing paragraphs, bold, code, ordered and unordered lists retain their markup', () => {
  const answer = '**Topic** and `x < y`.\nSecond line.\n\n- First\n* **Second**\n\n1. One\n2) `two`\n\n### Literal heading <tag>';
  assert.equal(renderToStaticMarkup(renderAnswer(answer)),
    '<div class="space-y-2"><p class="whitespace-pre-wrap break-words"><strong>Topic</strong> and <code class="px-1 py-0.5 rounded bg-black/5 font-mono text-[0.9em]">x &lt; y</code>.\nSecond line.</p>' +
    '<ul class="list-disc pl-5 space-y-1"><li class="break-words">First</li><li class="break-words"><strong>Second</strong></li></ul>' +
    '<ol class="list-decimal pl-5 space-y-1"><li class="break-words">One</li><li class="break-words"><code class="px-1 py-0.5 rounded bg-black/5 font-mono text-[0.9em]">two</code></li></ol>' +
    '<p class="whitespace-pre-wrap break-words">### Literal heading &lt;tag&gt;</p></div>');
});

test('links render alongside existing inline formatting without interpreting their title markup', () => {
  const result = renderAnswer(`**Watch:** [Video *one* and \`two\`](${url}) then \`code\`.`);
  assert.equal(elements(result, 'strong')[0].props.children, 'Watch:');
  assert.equal(elements(result, 'a')[0].props.children, 'Video *one* and `two`');
  assert.equal(elements(result, 'code').length, 1);
  assert.equal(elements(result, 'code')[0].props.children, 'code');
});
