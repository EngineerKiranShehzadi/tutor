import path from 'path';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import type { RawRow } from './chunk.service';

// Local, dependency-free SRT/VTT adapter. Timestamps are copied from the
// caption source, never inferred by an LLM or from character offsets.
export interface CaptionCue { startMs: number; endMs: number; text: string }
export interface SubtitleRows { rows: RawRow[]; warnings: string[]; units: number }
const MAX_CUES = 20_000;
const MAX_TEXT_BYTES = 4_000_000;
const MAX_GROUP_CHARS = 950;
const MAX_GROUP_MS = 90_000;

export const isSubtitleExtension = (ext: string): boolean => ext === '.srt' || ext === '.vtt';

const timestampMs = (value: string): number | null => {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1] ?? 0), minutes = Number(match[2]), seconds = Number(match[3]), millis = Number(match[4]);
  if (minutes >= 60 || seconds >= 60 || hours > 100) return null;
  return (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis;
};

export const formatCaptionTime = (ms: number): string => {
  const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
};

const cleanCaption = (value: string): string =>
  value.replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, m =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[m] ?? m))
    .replace(/\{\\an\d+\}/g, '')
    .replace(/\s+/g, ' ').trim();

export function parseSubtitle(buffer: Buffer, extension: string): CaptionCue[] {
  if (!isSubtitleExtension(extension)) throw new AppError('Unsupported subtitle format', 400);
  if (!buffer.length || buffer.length > MAX_TEXT_BYTES) throw new AppError('Subtitle file is empty or too large', 413);
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (extension === '.vtt' && !/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(source)) {
    throw new AppError('Invalid WEBVTT header', 422);
  }
  const blocks = source.split(/\n\s*\n/);
  const cues: CaptionCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(s => s.trim());
    if (!lines.length || /^(WEBVTT|NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0])) continue;
    const timeIndex = lines.findIndex(s => s.includes(' --> '));
    if (timeIndex < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timeIndex]);
    if (!match) throw new AppError('Malformed subtitle timing', 422);
    const startMs = timestampMs(match[1]), endMs = timestampMs(match[2]);
    if (startMs === null || endMs === null || endMs <= startMs) throw new AppError('Invalid subtitle timestamp', 422);
    const text = cleanCaption(lines.slice(timeIndex + 1).join(' '));
    if (!text) continue;
    cues.push({ startMs, endMs, text });
    if (cues.length > MAX_CUES) throw new AppError('Too many subtitle cues', 413);
  }
  if (!cues.length) throw new AppError('No usable timed captions found', 422);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].startMs < cues[i - 1].startMs) throw new AppError('Subtitle cues are not chronological', 422);
  }
  return cues;
}

export function captionCuesToRows(filename: string, cues: CaptionCue[]): SubtitleRows {
  const safeName = path.basename(filename).replace(/[\x00-\x1f]/g, ' ').slice(0, 140);
  if (!safeName || !cues.length) throw new AppError('Empty subtitle content', 422);
  const rows: RawRow[] = [];
  let group: CaptionCue[] = [];
  const flush = () => {
    if (!group.length) return;
    const start = formatCaptionTime(group[0].startMs);
    const end = formatCaptionTime(group[group.length - 1].endMs);
    rows.push({
      question: 'Source excerpt: ' + safeName + ' | ' + start + ' - ' + end,
      answer: group.map(c => c.text).join(' '),
      start_time: start,
      end_time: end,
    });
    if (rows.length > env.DATASET.MAX_ROWS) throw new AppError('Subtitle exceeds dataset row limit; split the file', 413);
    group = [];
  };
  for (const cue of cues) {
    // Never silently discard an oversized cue; split at word boundaries while
    // retaining the same authentic cue start/end (not fabricated sub-times).
    const pieces = cue.text.match(/.{1,850}(?:\s|$)|\S{1,850}/g) ?? [cue.text];
    for (const part of pieces) {
      const segment = { ...cue, text: part.trim() };
      if (!segment.text) continue;
      if (group.length && (
        group.map(c => c.text.length + 1).reduce((a, b) => a + b, 0) + segment.text.length > MAX_GROUP_CHARS ||
        segment.endMs - group[0].startMs > MAX_GROUP_MS
      )) flush();
      group.push(segment);
    }
  }
  flush();
  return { rows, warnings: [], units: cues.length };
}

export const subtitleToRows = (filename: string, buffer: Buffer, extension: string): SubtitleRows =>
  captionCuesToRows(filename, parseSubtitle(buffer, extension));
