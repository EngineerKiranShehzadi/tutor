import assert from 'assert/strict';

process.env.OPENAI_API_KEY = 'offline-test-vision-key';
const { mergeVisionIntoUnits, describeVisual } = require('../services/document-vision.service') as typeof import('../services/document-vision.service');

const originalFetch = globalThis.fetch;

async function run() {
  const merged = mergeVisionIntoUnits(
    [{locator: 'Slide 1', text: 'Conditional branches follow a decision node.'},
     {locator: 'Slide 2', text: 'Ordinary text slide.'},
     {locator: 'Slide 3', text: ''}],
    new Map([['Slide 1', 'Diamond: condition, Yes → A, No → B.'], ['Slide 3', 'Loop diagram: start → test → body → test.']])
  );
  assert.equal(merged.length, 3);
  assert.match(merged[0].text, /Conditional branches/);
  assert.match(merged[0].text, /Diamond: condition/);
  assert.equal(merged[1].text, 'Ordinary text slide.');
  assert.match(merged[2].text, /Loop diagram/);
  assert.equal(merged[2].locator, 'Slide 3');

  let captured = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = String(init?.body || '');
    return {
      ok: true,
      json: async () => ({choices: [{message:{content:JSON.stringify({relevant:true,description:'Diamond node branches Yes to A and No to B.'})}}]}),
    } as Response;
  }) as typeof fetch;
  const p = await describeVisual({locator:'Slide 12',image:'AQ=='},'Conditional branching follows the decision.');
  assert.equal(p.relevant,true);
  assert.match(p.description,/Diamond node/);
  assert.match(captured,/Conditional branching follows/);
  assert.match(captured,/image_url/);

  globalThis.fetch = (async () => ({
    ok:true, json:async()=>({choices:[{message:{content:JSON.stringify({relevant:false,description:''})}}]})
  } as Response)) as typeof fetch;
  const decorative = await describeVisual({locator:'Slide 1',image:'AQ=='},'Lecture introduction.');
  assert.equal(decorative.relevant,false);

  globalThis.fetch = (async () => ({
    ok:true,json:async()=>({choices:[{message:{content:'not valid JSON'}}]})
  } as Response)) as typeof fetch;
  await assert.rejects(()=>describeVisual({locator:'Slide 1',image:'AQ=='},'Malformed'),
    /invalid JSON/);

  globalThis.fetch = (async () => ({ok:false,status:429} as Response)) as typeof fetch;
  await assert.rejects(()=>describeVisual({locator:'Slide 1',image:'AQ=='},'Rate limited'),
    /HTTP 429/);
  console.log('Vision-context merging, decorative filtering and fail-closed validation passed');
}

run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{globalThis.fetch=originalFetch});
