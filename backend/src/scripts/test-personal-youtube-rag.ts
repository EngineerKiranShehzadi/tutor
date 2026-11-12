import assert from 'assert/strict';
import { citationUrl, vectorLiteral, personalRagEnabled, MAX_PERSONAL_VIDEO_CHUNKS } from '../services/personal-youtube-rag.service';

assert.equal(MAX_PERSONAL_VIDEO_CHUNKS,60);
assert.equal(citationUrl('abcdefghijk','00:01:05.000'),'https://www.youtube.com/watch?v=abcdefghijk&t=65s');
assert.throws(()=>citationUrl('bad','00:01:05.000'),/citation/);
assert.throws(()=>citationUrl('abcdefghijk','tomorrow'),/citation/);
assert.throws(()=>vectorLiteral([1,2,3]),/dimension/);
assert.throws(()=>vectorLiteral(Array(1024).fill(NaN)),/dimension/);
assert.equal(vectorLiteral(Array(1024).fill(0)).startsWith('[0,0,0'),true);
assert.equal(personalRagEnabled(),
  process.env.YOUTUBE_PILOT_ENABLED==='true' &&
  process.env.YOUTUBE_TRANSCRIPT_EXPERIMENTAL_ENABLED==='true' &&
  process.env.YOUTUBE_STUDENT_RAG_PILOT_ENABLED==='true' &&
  process.env.NODE_ENV!=='production');
console.log('Personal YouTube RAG offline checks passed');
