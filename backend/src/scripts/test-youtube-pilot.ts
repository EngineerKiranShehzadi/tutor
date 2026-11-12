// Offline pilot contract checks: no database, YouTube API key or embedding server.
import assert from 'assert/strict';
import { parseSubtitle, captionCuesToRows, subtitleToRows } from '../services/subtitle-ingestion.service';
import { validPlaylistId } from '../services/youtube-discovery.service';
import { buildChunkPiecesReport } from '../services/chunk.service';

async function main() {
  const srt = Buffer.from('1\n00:00:01,200 --> 00:00:04,000\nNamaste <i>students</i>!\n\n2\n00:00:04,500 --> 00:00:08,000\nToday we learn neural networks.\n');
  const vtt = Buffer.from('WEBVTT\n\n00:00:01.200 --> 00:00:04.000\nNamaste students!\n\n00:00:04.500 --> 00:00:08.000\nToday we learn neural networks.\n');
  const a = parseSubtitle(srt, '.srt'), b = parseSubtitle(vtt, '.vtt');
  assert.deepEqual(a, b);
  assert.equal(a[0].startMs, 1200);
  assert.equal(a[1].endMs, 8000);
  const result = subtitleToRows('lesson.srt', srt, '.srt');
  assert.equal(result.units, 2);
  assert.equal(result.rows[0].start_time, '00:00:01.200');
  assert.equal(result.rows[0].end_time, '00:00:08.000');
  assert.match(result.rows[0].answer!, /Namaste students/);
  assert.ok(!result.rows[0].answer!.includes('<i>'));
  const { pieces } = await buildChunkPiecesReport(result.rows[0]);
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0].chunkText.includes('neural networks'));
  assert.deepEqual(captionCuesToRows('lesson.srt', a), result);
  assert.throws(() => parseSubtitle(Buffer.from('WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nBad'), '.vtt'), /timestamp/);
  assert.throws(() => parseSubtitle(Buffer.from('NOT VTT'), '.vtt'), /WEBVTT/);
  assert.equal(validPlaylistId('PL4kipppqKObLmh-ZpCqp8iXj1V2guWyhj'), true);
  assert.equal(validPlaylistId('http://localhost/private'), false);
  console.log('YouTube pilot subtitle/metadata contract checks passed');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
