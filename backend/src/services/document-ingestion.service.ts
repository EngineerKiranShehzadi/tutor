import { spawn } from 'child_process';
import path from 'path';
import { AppError } from '../middleware/errorHandler';
import { RawRow } from './chunk.service';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { env } from '../config/env';

// The document boundary is isolated from the existing Excel parser and version
// planner. No remote conversion services are used; the child process reads only
// the uploaded bytes through stdin and outputs structured JSON through stdout.
export const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.txt', '.html', '.htm']);

export const supportedDatasetExtension = (filename: string): string | null => {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.xlsx' || DOCUMENT_EXTENSIONS.has(ext) ? ext : null;
};

type Unit = { locator: string; text: string };
export type ExtractionResult = { units: Unit[]; warnings: string[] };
export type DocumentRowsResult = { rows: RawRow[]; warnings: string[]; units: number };

const PYTHON_BIN = process.env.DOCUMENT_EXTRACT_PYTHON || 'python3';
const EXTRACT_SCRIPT = path.resolve(__dirname, '../../scripts/extract_document.py');
const MAX_RESULT_BYTES = 1_500_000;
const EXTRACT_TIMEOUT_MS = 30_000;

// Separate limits for different risks: compressed upload, extracted text,
// number of document pages/slides and the count of final database records.
const SECTION_SIZE = 1050;
const SECTION_OVERLAP = 130;
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: SECTION_SIZE,
  chunkOverlap: SECTION_OVERLAP,
  separators: ['\n\n', '\n', '. ', ' ', ''],
});

export const runDocumentExtractor = (buffer: Buffer, extension: string): Promise<ExtractionResult> => {
  if (!DOCUMENT_EXTENSIONS.has(extension)) {
    throw new AppError('Unsupported document format', 400);
  }
  if (buffer.length === 0 || buffer.length > env.DATASET.MAX_UPLOAD_BYTES) {
    throw new AppError('Document is empty or exceeds the upload size limit', 413);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [EXTRACT_SCRIPT, '--extension', extension], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    let settled = false;
    let output = '';
    let outputSize = 0;
    const settle = (err?: Error, result?: ExtractionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(result!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(new AppError('Document extraction timed out. Please upload a smaller file.', 422));
    }, EXTRACT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_RESULT_BYTES) {
        child.kill('SIGKILL');
        settle(new AppError('Document contains too much text. Please split the file.', 413));
      } else {
        output += chunk.toString('utf8');
      }
    });
    child.on('error', () => settle(new AppError('Document extractor is not available. Check Python dependencies.', 503)));
    child.on('close', (code) => {
      if (settled) return;
      let parsed: any;
      try { parsed = JSON.parse(output); } catch {
        settle(new AppError('Unable to extract this document. Please verify its format.', 422));
        return;
      }
      if (code !== 0 || parsed.error) {
        settle(new AppError(String(parsed.error ?? 'Document extraction failed').slice(0, 250), 422));
        return;
      }
      if (!Array.isArray(parsed.units) || !Array.isArray(parsed.warnings)) {
        settle(new AppError('Document extractor returned an invalid result', 422));
        return;
      }
      settle(undefined, parsed as ExtractionResult);
    });
    child.stdin.on('error', () => { /* Early child exit is surfaced through close. */ });
    child.stdin.end(buffer);
  });
};

// Each document section is stored as one content-bearing row in the existing
// dataset versioning tables. "Question" is a synthetic, deterministic source
// label, not an AI-generated question. "Answer" is the original document text.
// This preserves citations, stable IDs, deduplication and grounded generation.
export const documentToRows = async (
  filename: string, extracted: ExtractionResult
): Promise<DocumentRowsResult> => {
  const safeName = path.basename(filename).replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 180);
  if (!safeName) throw new AppError('Invalid filename', 400);
  if (!Array.isArray(extracted.units) || extracted.units.length === 0) {
    throw new AppError('No selectable text was found. Scanned files need OCR.', 422);
  }
  const rows: RawRow[] = [];
  let unitNumber = 0;
  for (const unit of extracted.units) {
    if (typeof unit?.text !== 'string' || typeof unit.locator !== 'string') {
      throw new AppError('Invalid document extraction result', 422);
    }
    unitNumber++;
    const text = unit.text.trim();
    if (!text) continue;
    const locator = unit.locator.replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, 90) || `Section ${unitNumber}`;
    const parts = await splitter.splitText(text);
    for (let part = 0; part < parts.length; part++) {
      const question = `Source excerpt: ${safeName} | ${locator} | Part ${part + 1}`;
      rows.push({
        question,
        answer: parts[part],
        topic: null as any,
        start_time: `${safeName} | ${locator}`,
      });
      if (rows.length > env.DATASET.MAX_ROWS) {
        throw new AppError(`Document contains more than ${env.DATASET.MAX_ROWS} sections. Split it into smaller files.`, 413);
      }
    }
  }
  if (!rows.length) throw new AppError('Document does not contain usable text', 422);
  return { rows, warnings: extracted.warnings.slice(0, 100), units: extracted.units.length };
};
