import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { AppError } from '../middleware/errorHandler';

/**
 * Boundaries are conservative: only explicit Q/A labels and lines ending in ?
 * initiate a paired unit. All other prose stays in ordinary document sections.
 * A detected question retains its answer in the SAME retrieval record; for long
 * answers the question is repeated on each child. No generative restructuring.
 */
export type LogicalSection =
  | {kind:'QA';question:string;answer:string;heading?:string}
  | {kind:'TEXT';text:string};

const slideLine=/^(?:slide|page)\s*(?:no\.?|number|#)?\s*[:.\-]?\s*\d+\s*(?:[:.\-].*)?$/i;
const qLine=/^(?:q(?:uestion)?\s*(?:no\.?\s*)?(?:#?\d+)?\s*[:.\-])\s*(.+)$/i;
const aLine=/^(?:a(?:ns(?:wer)?)?)\s*(?:#?\d+)?\s*:\s*(.*)$/i;
const explanationLine=/^(?:explanation|solution)\s*:\s*(.*)$/i;
const naturalQuestion=/^.{5,350}\?$/;
const inlinePair=/^(?:Q(?:uestion)?\s*(?:no\.?\s*)?(?:#?\d+)?\s*[:.\-])\s*(.+?)\s+(?:(?:A(?:ns(?:wer)?)?|Explanation|Solution)\s*(?:#?\d+)?\s*[:.\-])\s*(.+)$/i;
const MAX_UNIT=1050;
const OVERLAP=130;
const splitter=new RecursiveCharacterTextSplitter({
 chunkSize:MAX_UNIT,chunkOverlap:OVERLAP,separators:['\n\n','\n','. ',' ','']
});
export function isSlideBoundary(text:string):boolean {
 return slideLine.test(text.trim());
}
export function parseLogicalSections(text:string):LogicalSection[] {
 const lines=text.replace(/\r\n?/g,'\n').split('\n').map(x=>x.trim()).filter(Boolean);
 const result:LogicalSection[]=[];
 let heading:string|null=null, prose:string[]=[];
 const flushProse=()=>{if(prose.length)result.push({kind:'TEXT',text:[heading,...prose].filter(Boolean).join('\n')});prose=[];};
 const standaloneQ=/^(?:questions?|quesiton|q)$/i;
 const standaloneA=/^(?:answers?|a)$/i;
 const isQ=(line:string)=>standaloneQ.test(line)||/^(?:q|question|questions|quesiton)\s*:/i.test(line);
 const isA=(line:string)=>standaloneA.test(line)||/^(?:a|answer|answers)\s*:/i.test(line);
 for(let i=0;i<lines.length;){
  const line=lines[i];
  if(isSlideBoundary(line)){flushProse();heading=line;i++;continue;}
  const inline=inlinePair.exec(line);
  if(inline){flushProse();result.push({kind:'QA',question:inline[1].trim(),answer:inline[2].trim(),heading:heading??undefined});i++;continue;}
  if(isQ(line)){
   const qParts:string[]=[];const explicit=qLine.exec(line);
   if(explicit?.[1])qParts.push(explicit[1]);
   let j=i+1;
   while(j<lines.length&&!isA(lines[j])&&!isQ(lines[j])&&!isSlideBoundary(lines[j])){
    qParts.push(lines[j]);j++;
   }
   if(j<lines.length&&isA(lines[j])&&qParts.length){
    const aParts:string[]=[];const initial=lines[j].replace(/^(?:a|answers?)\s*:?\s*/i,'').trim();
    if(initial)aParts.push(initial);j++;
    while(j<lines.length&&!isQ(lines[j])&&!isSlideBoundary(lines[j])){aParts.push(lines[j]);j++;}
    if(aParts.length){
     flushProse();
     result.push({kind:'QA',question:qParts.join(' ').trim(),answer:aParts.join('\n'),heading:heading??undefined});
     i=j;continue;
    }
   }
   // Explicit Question: without Answer is invalid; unlabeled prompts stay prose.
   if(explicit?.[1] && (j>=lines.length || !isA(lines[j])))
    throw new AppError('An explicit Question has no matching Answer. Keep each question and its answer in the same slide or section.',422);
   prose.push(...lines.slice(i,j));i=j;continue;
  }
  const matchA=aLine.exec(line);
  if(matchA)throw new AppError('An Answer was found without its Question. Keep both in one logical section.',422);
  if(standaloneA.test(line)){prose.push(line);i++;continue;}
  prose.push(line);i++;
 }
 flushProse();return result;
}
export interface PreservedPart {
 kind:'QA'|'TEXT';question?:string;text:string;part:number;heading?:string;
}
export async function splitPreservingQuestions(text:string):Promise<PreservedPart[]> {
 const sections=parseLogicalSections(text);
 const out:PreservedPart[]=[];
 for(const section of sections){
  if(section.kind==='TEXT'){
   // Preserve the section title on EVERY child rather than allowing the
   // definition and explanation to lose their subject after a character split.
   const [first,...rest]=section.text.split('\n');
   const title=first.trim().length<=110 && /^(?:slide|page|chapter|section|unit)\s*(?:\d+|[:#.-])|^#{1,4}\s+/i.test(first.trim())
     ? first.trim() : null;
   const body=title?rest.join('\n').trim():section.text;
   if(!body)continue;
   const scopedSplitter=title?new RecursiveCharacterTextSplitter({
     chunkSize:MAX_UNIT-title.length-20,chunkOverlap:OVERLAP,
     separators:['\n\n','\n','. ',' ','']
   }):splitter;
   const parts=await scopedSplitter.splitText(body);
   for(const [i,part] of parts.entries())out.push({kind:'TEXT',text:title?title+'\n'+part:part,part:i+1});
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
  for(const [i,part] of parts.entries())out.push({kind:'QA',question:section.question,text:part,part:i+1,heading:section.heading});
 }
 return out;
}
