import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { AppError } from '../middleware/errorHandler';

/** A question and its answer must share one retrieval unit. Long answers may
 * span child rows, but the original question is repeated on every child. */
export type LogicalSection =
 | { kind:'QA'; question:string; answer:string }
 | { kind:'TEXT'; text:string };

const boundary=/^(?:slide|page)\s*(?:no\.?|number|#)?\s*[:.\-]?\s*\d+\s*(?:[:.\-]|$)/i;
const questionStart=/^(?:q(?:uestion)?\s*(?:\d+)?\s*[:.\-]\s*)(.+)$/i;
const answerStart=/^(?:a(?:nswer)?\s*(?:\d+)?\s*[:.\-]\s*)(.*)$/i;
const softQuestion=/^.{5,350}\?$/;
const MAX_UNIT=1050;
const OVERLAP=130;
const splitter=new RecursiveCharacterTextSplitter({
 chunkSize:MAX_UNIT,chunkOverlap:OVERLAP,separators:['\n\n','\n','. ',' ','']
});
export function isSlideBoundary(text:string):boolean{
 return boundary.test(text.trim());
}
export function parseLogicalSections(text:string):LogicalSection[]{
 const blocks=text.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
 const result:LogicalSection[]=[];
 let question:string|null=null;
 let answer:string[]=[];
 let prose:string[]=[];
 const flushProse=()=>{if(prose.length){result.push({kind:'TEXT',text:prose.join('\n\n')});prose=[];}};
 const flushQuestion=()=>{
  if(question!==null){
   if(answer.some(x=>x.trim()))result.push({kind:'QA',question,answer:answer.join('\n\n')});
   else result.push({kind:'TEXT',text:question});
   question=null;answer=[];
  }
 };
 for(const block of blocks){
  if(isSlideBoundary(block)){
   flushQuestion();flushProse();prose.push(block);
   continue;
  }
  const explicit=questionStart.exec(block);
  const answerMatch=answerStart.exec(block);
  const candidate=explicit?.[1]?.trim()??(softQuestion.test(block)?block:null);
  if(candidate){
   flushQuestion();flushProse();question=candidate;continue;
  }
  if(answerMatch&&question!==null){
   if(answerMatch[1]?.trim())answer.push(answerMatch[1].trim());
   continue;
  }
  if(question!==null){answer.push(block);}
  else prose.push(block);
 }
 flushQuestion();flushProse();
 return result;
}
export interface PreservedPart {
 kind:'QA'|'TEXT';question?:string;text:string;part:number;
}
export async function splitPreservingQuestions(text:string):Promise<PreservedPart[]>{
 const sections=parseLogicalSections(text);
 const out:PreservedPart[]=[];
 for(const section of sections){
  if(section.kind==='TEXT'){
   for(const [i,p] of (await splitter.splitText(section.text)).entries())out.push({kind:'TEXT',text:p,part:i+1});
   continue;
  }
  // The question is metadata, not part of the answer body which is split.
  // Every child carries it so a vector/rerank hit never loses its referent.
  if(section.question.length>350)throw new AppError('Question text is too long to preserve safely',422);
  const maxAnswer=Math.max(250,MAX_UNIT-section.question.length-60);
  const answerSplitter=new RecursiveCharacterTextSplitter({chunkSize:maxAnswer,
   chunkOverlap:Math.min(OVERLAP,Math.floor(maxAnswer/5)),separators:['\n\n','\n','. ',' ','']});
  const pieces=await answerSplitter.splitText(section.answer);
  if(!pieces.length)throw new AppError('Question has no answer in uploaded document',422);
  if(pieces.length>20)throw new AppError('A single answer is too long; split it into smaller sections before upload',422);
  for(const [i,p] of pieces.entries())out.push({kind:'QA',question:section.question,text:p,part:i+1});
 }
 return out;
}
