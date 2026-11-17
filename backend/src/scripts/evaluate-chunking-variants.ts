/**
 * Offline lexical-proxy comparison of the previous chunk boundaries (A) and
 * format-aware boundaries (B). No DB, embedding provider, LLM, Phoenix, or
 * reranker is called. Document queries are deterministic prompts derived from
 * source answer spans; workbook queries use the actual curated questions.
 *
 * Usage:
 *   ts-node --transpile-only src/scripts/evaluate-chunking-variants.ts \
 *     <lecture.xlsx> <lecture.docx> <deck.pptx> <handout.pdf>
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import * as XLSX from 'xlsx';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { documentToRows, ExtractionResult } from '../services/document-ingestion.service';
import { buildChunkPiecesReport, parseExcel, RawRow } from '../services/chunk.service';

type Candidate = { locator: string; text: string };
type Case = { query: string; locator: string; answer: string };
type Score = { evaluated: number; hitsAt5: number; recallAt5: number; mrrAt5: number };

const STOP = new Set(('a an and are as at be by for from how in is it of on or that the this to was what when which with').split(' '));
const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => !STOP.has(t));
const separators = ['\n\n', '\n', '. ', ' ', ''];

function makeText(row: RawRow): string {
  return [row.topic ? `Topic: ${row.topic}` : null, `Question: ${row.question}`, `Answer: ${row.answer}`, row.keywords ? `Keywords: ${row.keywords}` : null]
    .filter(Boolean).join('\n').trim();
}

async function excelCandidates(rows: RawRow[], variant: 'A' | 'B'): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: variant === 'A' ? 1200 : 1800,
    chunkOverlap: 150,
    separators,
  });
  for (const [index, row] of rows.entries()) {
    const whole = makeText(row);
    const threshold = variant === 'A' ? 1800 : 3200;
    const parts = whole.length <= threshold ? [whole] : await splitter.splitText(String(row.answer ?? ''));
    for (const part of parts) {
      out.push({
        locator: `Worksheet row ${index + 1}`,
        text: whole.length <= threshold ? whole : [row.topic ? `Topic: ${row.topic}` : null, `Question: ${row.question}`, `Answer: ${part}`, row.keywords ? `Keywords: ${row.keywords}` : null]
          .filter(Boolean).join('\n').trim(),
      });
    }
  }
  return out;
}

async function documentCandidates(filename: string, extraction: ExtractionResult, variant: 'A' | 'B'): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (variant === 'A') {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1050, chunkOverlap: 130, separators });
    for (const unit of extraction.units) {
      const chunks = await splitter.splitText(unit.text);
      chunks.forEach((part, index) => out.push({
        locator: unit.locator,
        text: `Topic: ${unit.locator}\nQuestion: Source excerpt: ${path.basename(filename)} | ${unit.locator} | Part ${index + 1}\nAnswer: ${part}`,
      }));
    }
    return out;
  }
  const mapped = await documentToRows(path.basename(filename), extraction);
  for (const row of mapped.rows) {
    const { pieces } = await buildChunkPiecesReport(row);
    const locator = String(row.start_time ?? '').split(' | ').slice(1).join(' | ') || 'Document';
    for (const piece of pieces) out.push({ locator, text: piece.chunkText });
  }
  return out;
}

function sourceCases(units: ExtractionResult['units']): Case[] {
  const cases: Case[] = [];
  for (const unit of units) {
    const sentences = unit.text.split(/\n+|(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length >= 45 && s.length <= 500);
    for (const sentence of sentences.slice(0, 4)) {
      const terms = tokens(sentence);
      if (terms.length < 7) continue;
      cases.push({
        query: `What does the lecture say about ${terms.slice(0, 6).join(' ')}?`,
        locator: unit.locator,
        answer: sentence,
      });
    }
  }
  return cases;
}

function rank(cases: Case[], corpus: Candidate[]): Score {
  const corpusTerms = corpus.map(c => tokens(c.text));
  const df = new Map<string, number>();
  for (const terms of corpusTerms) for (const term of new Set(terms)) df.set(term, (df.get(term) ?? 0) + 1);
  const avgLen = corpusTerms.reduce((n, ts) => n + ts.length, 0) / Math.max(1, corpusTerms.length);
  let hitsAt5 = 0, rr = 0;
  for (const test of cases) {
    const qterms = tokens(test.query);
    const ranked = corpus.map((candidate, i) => {
      const counts = new Map<string, number>();
      for (const term of corpusTerms[i]) counts.set(term, (counts.get(term) ?? 0) + 1);
      const len = corpusTerms[i].length;
      const score = qterms.reduce((sum, term) => {
        const freq = counts.get(term) ?? 0;
        if (!freq) return sum;
        const idf = Math.log(1 + (corpus.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        return sum + idf * (freq * 2.2) / (freq + 1.2 * (0.25 + 0.75 * len / Math.max(1, avgLen)));
      }, 0);
      return { candidate, score, index: i };
    }).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 5);

    const gold = new Set(tokens(test.answer));
    let accumulated = new Set<string>();
    let reciprocalRank = 0;
    for (const [index, entry] of ranked.entries()) {
      if (entry.candidate.locator === test.locator) {
        for (const token of tokens(entry.candidate.text)) if (gold.has(token)) accumulated.add(token);
      }
      if (accumulated.size / Math.max(1, gold.size) >= 0.75) {
        reciprocalRank = 1 / (index + 1);
        break;
      }
    }
    if (reciprocalRank > 0) hitsAt5++;
    rr += reciprocalRank;
  }
  return { evaluated: cases.length, hitsAt5, recallAt5: cases.length ? hitsAt5 / cases.length : 0, mrrAt5: cases.length ? rr / cases.length : 0 };
}

function extract(filename: string): ExtractionResult {
  const ext = path.extname(filename).toLowerCase();
  const script = path.resolve(__dirname, '../../scripts/extract_document.py');
  const result = spawnSync(process.env.DOCUMENT_EXTRACT_PYTHON || 'python3', [script, '--extension', ext, '--allow-visual'], {
    input: fs.readFileSync(filename), maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.status !== 0) throw new Error(`${path.basename(filename)} extraction failed: ${result.stdout || result.stderr}`);
  const parsed = JSON.parse(result.stdout) as ExtractionResult & { error?: string };
  if (parsed.error) throw new Error(`${path.basename(filename)} extraction failed: ${parsed.error}`);
  return parsed;
}

async function evaluate(): Promise<void> {
  const [xlsxPath, docxPath, pptxPath, pdfPath] = process.argv.slice(2);
  if (![xlsxPath, docxPath, pptxPath, pdfPath].every(p => p && fs.existsSync(p))) {
    throw new Error('Pass existing paths in order: <lecture.xlsx> <lecture.docx> <deck.pptx> <handout.pdf>');
  }
  const xlsxRows = parseExcel(fs.readFileSync(xlsxPath));
  const input = XLSX.readFile(xlsxPath);
  const sheetName = input.SheetNames.find(n => n.trim().toLowerCase() === 'final_dataset') ?? input.SheetNames[0];
  const worksheet = input.Sheets[sheetName];
  const workbookRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' });
  const qaCases: Case[] = xlsxRows.map((row, index) => ({ query: String(row.question ?? ''), locator: `Worksheet row ${index + 1}`, answer: String(row.answer ?? '') }));

  const documents = [docxPath, pptxPath, pdfPath].map(filename => ({ filename, extraction: extract(filename) }));
  const result: Record<string, unknown> = {
    method: 'offline BM25-style lexical proxy; source-location plus >=75% gold answer-token coverage within top 5; no live embeddings/LLM/reranker/database',
    excelSource: path.basename(xlsxPath), excelRows: workbookRows.length, excelCases: qaCases.length,
    documents: {},
  };
  const documentsResult = result.documents as Record<string, unknown>;
  const excelA = await excelCandidates(xlsxRows, 'A');
  const excelB = await excelCandidates(xlsxRows, 'B');
  documentsResult[path.basename(xlsxPath)] = {
    variantA: { chunks: excelA.length, ...rank(qaCases, excelA) },
    variantB: { chunks: excelB.length, ...rank(qaCases, excelB) },
  };
  for (const { filename, extraction } of documents) {
    const sourceGold = sourceCases(extraction.units);
    const a = await documentCandidates(filename, extraction, 'A');
    const b = await documentCandidates(filename, extraction, 'B');
    documentsResult[path.basename(filename)] = {
      units: extraction.units.length, warnings: extraction.warnings,
      cases: sourceGold.length,
      variantA: { chunks: a.length, ...rank(sourceGold, a) },
      variantB: { chunks: b.length, ...rank(sourceGold, b) },
    };
  }
  console.log(JSON.stringify(result, null, 2));
}

evaluate().catch(err => { console.error(err); process.exitCode = 1; });
