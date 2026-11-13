import { spawn } from 'child_process';
import path from 'path';

// A caption check is tri-state. Access errors must not be presented as
// "this playlist has no captions" and must not poison the negative cache.
export type CaptionEligibility = 'available' | 'unavailable' | 'unknown';
const cache = new Map<string, {state:Exclude<CaptionEligibility,'unknown'>;expires:number}>();
const MAX_CACHE = 300;
const SCRIPT=path.resolve(__dirname,'../../scripts/fetch_youtube_transcript.py');
const permanentUnavailable=new Set([
  'CAPTIONS_DISABLED','SUPPORTED_CAPTIONS_NOT_FOUND','VIDEO_UNAVAILABLE'
]);
export async function checkCaptionEligibility(videoId:string):Promise<CaptionEligibility> {
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return 'unavailable';
  if(process.env.YOUTUBE_TRANSCRIPT_EXPERIMENTAL_ENABLED!=='true')return 'unknown';
  const hit=cache.get(videoId);
  if(hit && hit.expires>Date.now())return hit.state;
  const result=await new Promise<CaptionEligibility>(resolve=>{
    const child=spawn(process.env.YOUTUBE_TRANSCRIPT_PYTHON||'python3',[SCRIPT,videoId],{
      shell:false,stdio:['ignore','pipe','ignore'],
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}
    });
    let output='',done=false;
    const finish=(state:CaptionEligibility)=>{
      if(done)return;done=true;clearTimeout(timer);resolve(state);
    };
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish('unknown');},12000);
    child.stdout.on('data',(b:Buffer)=>{
      output+=b.toString('utf8');
      if(Buffer.byteLength(output)>2_000_000){child.kill('SIGKILL');finish('unknown');}
    });
    child.on('error',()=>finish('unknown'));
    child.on('close',code=>{
      try{
        const parsed=JSON.parse(output);
        if(code!==0){
          finish(permanentUnavailable.has(String(parsed?.error))?'unavailable':'unknown');
          return;
        }
        finish(Array.isArray(parsed?.cues)&&parsed.cues.some((c:any)=>
          typeof c?.text==='string'&&c.text.trim().length>0
        )?'available':'unavailable');
      }catch{finish('unknown');}
    });
  });
  if(result!=='unknown'){
    if(cache.size>=MAX_CACHE)cache.delete(cache.keys().next().value!);
    cache.set(videoId,{state:result,expires:Date.now()+(result==='available'?15:2)*60_000});
  }
  return result;
}
export async function hasUsableCaptions(videoId:string):Promise<boolean> {
  return (await checkCaptionEligibility(videoId))==='available';
}
