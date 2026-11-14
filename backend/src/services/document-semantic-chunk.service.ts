import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { AppError } from '../middleware/errorHandler';

/**
 * Boundaries are conservative: only explicit Q/A labels and lines ending in ?
 * initiate a paired unit. All other prose stays in ordinary document sections.
 * A detected question retains its answer in the SAME retrieval record; for long
 * answers the question is repeated on each child. No generative restructuring.
 */
export type LogicalSection =
  | {kind:'QA';question:string;answer:string}
  | {kind:'TEXT';text:string};

const slideLine=/^(?:slide|page)\s*(?:no\.?|number|#)?\s*[:.\-]?\s*\d+\s*(?:[:.\-].*)?$/i;
const qLine=/^(?:q(?:uestion)?\s*(?:#?\d+)?\s*[:.\-])\s*(.+)$/i;
const aLine=/^(?:a(?:nswer)?\s*(?:#?\d+)?\s*[:.\-])\s*(.*)$/i;
const naturalQuestion=/^.{5,350}\?$/;
const MAX_UNIT=1050;
const OVERLAP=130;
const splitter=new RecursiveCharacterTextSplitter({
 chunkSize:MAX_UNIT,chunkOverlap:OVERLAP,separators:['\n\n','\n','. ',' ','']
});
export function isSlideBoundary(text:string):boolean {
 return slideLine.test(text.trim());
}
export function parseLogicalSections(text:string):LogicalSection[] {
 const lines=text.replace(/\r\n?/g,'\n').split('\n');
 const result:LogicalSection[]=[];
 let question:string|null=null;
 let answer:string[]=[];
 let prose:string[]=[];
 const flushProse=()=>{
  if(prose.some(x=>x.trim()))result.push({kind:'TEXT',text:prose.join('\n').trim()});
  prose=[];
 };
 const flushQA=()=>{
  if(question!==null){
   if(answer.some(x=>x.trim()))result.push({kind:'QA',question,answer:answer.join('\n').trim()});
   else result.push({kind:'TEXT',text:question});
  }
  question=null;answer=[];
 };
 for(const raw of lines){
  const line=raw.trim();
  if(!line){
   if(question!==null && answer.length)answer.push('');
   else if(question===null && prose.length)prose.push('');
   continue;
  }
  if(isSlideBoundary(line)){
   flushQA();flushProse();
   prose.push(line);
   continue;
  }
  const matchQ=qLine.exec(line);
  const matchA=aLine.exec(line);
  const candidate=matchQ?.[1]?.trim()??(naturalQuestion.test(line)?line:null);
  if(candidate){
   flushQA();flushProse();question=candidate;
   continue;
  }
  if(matchA && question!==null){
   if(matchA[1].trim())answer.push(matchA[1].trim());
   continue;
  }
  if(question!==null)answer.push(line);
  else prose.push(line);
 }
 flushQA();flushProse();
 return result;
}
export interface PreservedPart {
 kind:'QA'|'TEXT';question?:string;text:string;part:number;
}
export async function splitPreservingQuestions(text:string):Promise<PreservedPart[]> {
 const sections=parseLogicalSections(text);
 const out:PreservedPart[]=[];
 for(const section of sections){
  if(section.kind==='TEXT'){
   const parts=await splitter.splitText(section.text);
   for(const [i,part] of parts.entries())out.push({kind:'TEXT',text:part,part:i+1});
   continue;
  }
  if(section.question.length>350)throw new AppError('Question text exceeds safe chunk budget',422);
  const answerSize=MAX_UNIT-section.question.length-80;
  const answerSplitter=new RecursiveCharacterTextSplitter({
   chunkSize:answerSize,chunkOverlap:Math.min(OVERLAP,Math.floor(answerSize/5)),
   separators:['\n\n','\n','. ',' ','']
  });
  const parts=await answerSplitter.splitText(section.answer);
  if(!parts.length)throw new AppError('Question has no answer in document',422);
  if(parts.length>20)throw new AppError('A long answer needs smaller logical sections before upload',422);
  for(const [i,part] of parts.entries())out.push({kind:'QA',question:section.question,text:part,part:i+1});
 }
 return out;
}
