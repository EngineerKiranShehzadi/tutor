/**
 * Explicit, LOCAL-ONLY, live provider smoke for the student YouTube pilot.
 * This script creates a personal course in the configured local database.
 *
 * Requires YOUTUBE_SMOKE_CONFIRM=LOCAL_THROWAWAY_DB, a fresh student account,
 * YOUTUBE_SMOKE_STUDENT_TOKEN and YOUTUBE_SMOKE_PLAYLIST_ID.
 * Optional: YOUTUBE_SMOKE_OTHER_STUDENT_TOKEN for cross-account 404 checks.
 *
 * Never put tokens or API keys on the command line or commit them to Git.
 */
import assert from 'assert/strict';

const confirm = process.env.YOUTUBE_SMOKE_CONFIRM;
const baseRaw = process.env.YOUTUBE_SMOKE_BASE_URL || 'http://127.0.0.1:5000/api/v1';
const token = process.env.YOUTUBE_SMOKE_STUDENT_TOKEN || '';
const otherToken = process.env.YOUTUBE_SMOKE_OTHER_STUDENT_TOKEN || '';
const playlistId = process.env.YOUTUBE_SMOKE_PLAYLIST_ID || '';
const question = process.env.YOUTUBE_SMOKE_QUESTION || 'What is the main concept explained in this video?';

function setup() {
  if (confirm !== 'LOCAL_THROWAWAY_DB') throw new Error('Explicit local throwaway DB confirmation required');
  const base = new URL(baseRaw);
  if (base.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(base.hostname) ||
      base.username || base.password || base.search || base.hash ||
      !base.pathname.endsWith('/api/v1')) {
    throw new Error('Only a local http://localhost or http://127.0.0.1 /api/v1 backend is allowed');
  }
  if (!token || !/^[A-Za-z0-9_-]{10,100}$/.test(playlistId))
    throw new Error('Student bearer token and valid playlist ID are required');
  if (question.length < 3 || question.length > 500) throw new Error('Question must be 3-500 characters');
  return base.toString().replace(/\/$/,'');
}
type Method = 'GET' | 'POST' | 'DELETE';
interface ApiEnvelope { success: boolean; message?: string; data?: any }
async function call(base:string, method:Method, path:string, bearer:string, body?:unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),60_000);
  try {
    const response = await fetch(base+path,{
      method,
      headers:{ Authorization:'Bearer '+bearer, ...(body ? {'Content-Type':'application/json'} : {}) },
      body:body ? JSON.stringify(body) : undefined,
      signal:controller.signal,
      redirect:'error',
    });
    const payload = await response.json() as ApiEnvelope;
    return { status:response.status, payload };
  } finally { clearTimeout(timer); }
}
function requireSuccess(r:{status:number;payload:ApiEnvelope},stage:string) {
  if (r.status < 200 || r.status >= 300 || !r.payload.success)
    throw new Error(stage+' failed (HTTP '+r.status+'): '+String(r.payload.message || 'unknown').slice(0,160));
  return r.payload.data;
}
const sleep = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const statusValues = ['PREVIEW_ONLY','QUEUED','PROCESSING','PARTIAL','READY','FAILED'];

async function main() {
  const base=setup();
  const state=requireSuccess(await call(base,'GET','/youtube/my-courses/pilot-status',token),'pilot status');
  assert.equal(state.enabled,true,'Local personal RAG pilot must be enabled');
  const previous=requireSuccess(await call(base,'GET','/youtube/my-courses',token),'existing courses');
  if ((previous.courses || []).some((c:any)=>c.playlist_id===playlistId))
    throw new Error('Playlist already belongs to this student; use a fresh local test account/playlist');
  console.log('Local pilot ready; creating exactly one personal course (max 2 videos)');
  const created=requireSuccess(await call(base,'POST','/youtube/my-courses',token,{playlistId}),'add course');
  const course=created.course;
  assert.ok(course?.id,'Missing personal course ID');
  assert.ok(Array.isArray(course.videos) && course.videos.length>=1 && course.videos.length<=2);
  const id=encodeURIComponent(String(course.id));
  const knownVideoIds=new Set(course.videos.map((v:any)=>v.video_id));
  console.log('Course created; videos='+course.videos.length+'; starting explicit caption import');
  requireSuccess(await call(base,'POST','/youtube/my-courses/'+id+'/ingest',token),'start import');
  let status='',details:any;
  const maxWaitMs=6*60*1000;
  const started=Date.now();
  while (Date.now()-started<maxWaitMs) {
    const result=requireSuccess(await call(base,'GET','/youtube/my-courses',token),'poll status');
    details=(result.courses || []).find((c:any)=>String(c.id)===String(course.id));
    assert.ok(details,'Course disappeared while importing');
    assert.ok(statusValues.includes(details.status),'Unknown import status');
    if (status!==details.status) { status=details.status; console.log('Import status: '+status); }
    if (['READY','PARTIAL','FAILED'].includes(status)) break;
    await sleep(5000);
  }
  if (!['READY','PARTIAL'].includes(status))
    throw new Error('Import did not produce any READY video. Inspect per-video caption errors on the local dashboard.');
  const readyVideos=details.videos.filter((v:any)=>v.ingest_status==='READY');
  assert.ok(readyVideos.length>0 && readyVideos.length<=2);
  console.log('Indexed '+readyVideos.length+'/'+course.videos.length+' videos; asking one grounded question');
  const answer=requireSuccess(await call(base,'POST','/youtube/my-courses/'+id+'/ask',token,{question}),'ask');
  assert.ok(typeof answer.answer==='string' && answer.answer.trim(),'Empty AI answer');
  assert.ok(Array.isArray(answer.sources),'Missing source array');
  if (!answer.sources.length) throw new Error('No grounded citations. Try a question directly answered by the video transcript.');
  for (const source of answer.sources) {
    assert.ok(knownVideoIds.has(source.videoId),'Citation references a video outside this course');
    const expected = new URL('https://www.youtube.com/watch?v='+source.videoId);
    const actual = new URL(source.url);
    assert.equal(actual.origin,expected.origin);
    assert.equal(actual.searchParams.get('v'),source.videoId);
    assert.match(source.startTime,/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.match(actual.searchParams.get('t')||'',/^\d+s$/);
  }
  console.log('Grounded answer with '+answer.sources.length+' validated video timestamp citation(s)');

  if (otherToken) {
    const foreignList=requireSuccess(await call(base,'GET','/youtube/my-courses',otherToken),'other student list');
    assert.ok(!(foreignList.courses || []).some((c:any)=>String(c.id)===String(course.id)),
      'Private course appeared in another student account');
    for (const [method,path,body] of [
      ['POST','/youtube/my-courses/'+id+'/ask',{question}],
      ['POST','/youtube/my-courses/'+id+'/ingest',undefined],
      ['DELETE','/youtube/my-courses/'+id,undefined],
    ] as const) {
      const r=await call(base,method,path,otherToken,body);
      assert.equal(r.status,404,'Cross-student operation must return 404');
    }
    console.log('Cross-student access checks passed (list, ask, ingest, delete)');
  } else console.log('Cross-student HTTP checks skipped; supply YOUTUBE_SMOKE_OTHER_STUDENT_TOKEN to run them');

  console.log('LIVE LOCAL SMOKE PASSED. Test course remains for inspection; delete it in the dashboard after review.');
}
main().catch(e=>{ console.error('LIVE LOCAL SMOKE FAILED: '+String((e as Error).message).slice(0,300));process.exitCode=1; });
