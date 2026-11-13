import { spawn } from 'child_process';
import path from 'path';

// Probe uses the same caption parser as the importer, but never embeds or stores
// video content. Cache is short-lived: video owners can change captions at any time.
const cache = new Map<string,{ok:boolean;expires:number}>();
const MAX_CACHE=300;
const PYTHON=()=>process.env.YOUTUBE_TRANSCRIPT_PYTHON||'python3';
const SCRIPT=path.resolve(__dirname,'../../scripts/fetch_youtube_transcript.py');
export async function hasUsableCaptions(videoId:string):Promise<boolean> {
  if(!/^[A-Za-z0-9_-]{11}$/.test(videoId))return false;
  if(process.env.YOUTUBE_TRANSCRIPT_EXPERIMENTAL_ENABLED!=='true')return false;
  const hit=cache.get(videoId);
  if(hit && hit.expires>Date.now())return hit.ok;
  const ok=await new Promise<boolean>(resolve=>{
    const child=spawn(PYTHON(),[SCRIPT,videoId],{shell:false,stdio:['ignore','pipe','ignore'],
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    let output='',done=false;
    const finish=(value:boolean)=>{
      if(done)return;done=true;clearTimeout(timer);resolve(value);
    };
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(false);},12000);
    child.stdout.on('data',(b:Buffer)=>{
      output+=b.toString('utf8');
      if(output.length>2_000_000){child.kill('SIGKILL');finish(false);}
    });
    child.on('error',()=>finish(false));
    child.on('close',(code)=>{
      if(code!==0){finish(false);return;}
      try {
        const result=JSON.parse(output);
        finish(Array.isArray(result.cues)&&result.cues.some((x:any)=>typeof x.text==='string'&&x.text.trim().length>0));
      }catch{finish(false);}
    });
  });
  if(cache.size>=MAX_CACHE)cache.delete(cache.keys().next().value!);
  cache.set(videoId,{ok,expires:Date.now()+(ok?15*60_000:2*60_000)});
  return ok;
}
