import assert from 'assert/strict';
import { PILOT_VIDEO_LIMIT, validateCaptionPayload, pilotEnabled } from '../services/youtube-import.service';
import { captionCuesToRows } from '../services/subtitle-ingestion.service';

assert.equal(PILOT_VIDEO_LIMIT,2);
const data = validateCaptionPayload({language:'hi',cues:[
  {startMs:1000,endMs:3000,text:'नमस्ते छात्रों'},
  {startMs:4000,endMs:6000,text:'Deep learning basics'},
]});
const rows = captionCuesToRows('abcdefghijk-hi.vtt',data.cues);
assert.equal(rows.rows[0].start_time,'00:00:01.000');
assert.match(rows.rows[0].question!,/abcdefghijk/);
assert.throws(()=>validateCaptionPayload({cues:[{startMs:10,endMs:5,text:'bad'}]}),/timing/);
assert.throws(()=>validateCaptionPayload({cues:[]}),/usable/);
assert.equal(pilotEnabled(),process.env.YOUTUBE_PILOT_ENABLED==='true' &&
  process.env.YOUTUBE_TRANSCRIPT_EXPERIMENTAL_ENABLED==='true' &&
  process.env.NODE_ENV!=='production');
console.log('YouTube import offline checks passed');
