/**
 * Build an editable, UNREVIEWED golden-benchmark worksheet from the existing
 * read-only lecture export. Never invent verified evidence or correctness.
 * Usage: npm run eval:review-worksheet -- <rag-review-*.json>
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

type Candidate = {
  id: string; lectureId: number; datasetVersionId: number; question: string;
  suggestedChunkIds: number[];
  evidencePreview: Array<{chunkId:number;sourceLocator:string|null;excerpt:string}>;
};
type Input = {status:string;lectureId:number;datasetVersionId:number;lectureTitle:string;cases:Candidate[]};
const categories = ['factual','conceptual','comparison','compound','follow_up','unsupported','ambiguous','keyword','paraphrase'] as const;
function category(question:string):typeof categories[number] {
  if (/^(what is|what does .* mean|define)/i.test(question)) return 'conceptual';
  if (/^(why|how does|how is)/i.test(question)) return 'conceptual';
  if (/\b(and|compare|difference between)\b/i.test(question)) return 'compound';
  return 'factual';
}
function main() {
  const file=process.argv[2];
  if (!file) throw Error('Usage: npm run eval:review-worksheet -- <rag-review-*.json>');
  const doc=JSON.parse(readFileSync(resolve(file),'utf8')) as Input;
  if(doc.status!=='REVIEW_REQUIRED'||!Array.isArray(doc.cases)||!doc.cases.length)
    throw Error('Expected a nonempty REVIEW_REQUIRED candidate export');
  if(!Number.isSafeInteger(doc.lectureId)||!Number.isSafeInteger(doc.datasetVersionId))
    throw Error('Invalid lecture/version identifiers');
  const seen=new Set<string>();
  const cases=doc.cases.map(c=>{
    if(seen.has(c.id)||c.lectureId!==doc.lectureId||c.datasetVersionId!==doc.datasetVersionId)
      throw Error('Duplicate ID or inconsistent pinned dataset');
    seen.add(c.id);
    return {
      id:c.id,lectureId:c.lectureId,datasetVersionId:c.datasetVersionId,
      question:c.question,category:category(c.question),
      answerable:null as boolean|null,
      expectedChunkIds:[] as number[],
      suggestedChunkIds:c.suggestedChunkIds,
      evidencePreview:c.evidencePreview,
      reviewed:false,reviewedBy:'',
      reviewerNotes:'',
    };
  });
  // These are proposed prompts for human editing, NOT evidence-grounded facts.
  // Unsupported must be confirmed absent from the WHOLE pinned lecture.
  const proposals=[
    {suffix:'paraphrase',category:'paraphrase',question:'Rewrite one selected question in different words without changing its meaning.',basedOn:cases[0].id},
    {suffix:'compound',category:'compound',question:'Combine two independently supported lecture questions into one multi-part question.',basedOn:cases.slice(0,2).map(c=>c.id).join(', ')},
    {suffix:'unsupported',category:'unsupported',question:'Write a question demonstrably not answered anywhere in this pinned lecture.',basedOn:'Full lecture review required'},
    {suffix:'follow_up',category:'follow_up',question:'Write a context-dependent follow-up to a reviewed lecture question.',basedOn:cases[0].id},
  ];
  const worksheet={
    schemaVersion:1,status:'HUMAN_REVIEW_PENDING',lectureId:doc.lectureId,
    datasetVersionId:doc.datasetVersionId,lectureTitle:doc.lectureTitle,
    instructions:'Review against original lecture sources. Replace proposal prompts with real questions. Set answerable, expectedChunkIds, reviewed=true and reviewedBy only after independent evidence checking. Never treat suggestedChunkIds as ground truth.',
    cases,proposals,
    categoryCounts:Object.fromEntries(categories.map(k=>[k,cases.filter(c=>c.category===k).length]))
  };
  const output=resolve(file.replace(/\.json$/i,'')+'-worksheet.json');
  if(output===resolve(file))throw Error('Input must be a .json file');
  writeFileSync(output,JSON.stringify(worksheet,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Created '+cases.length+' unreviewed review rows and '+proposals.length+' question-design prompts.');
  console.log('Worksheet: '+output);
  console.log('No evidence was automatically verified; no database or API calls made.');
}
try{main()}catch(e){console.error('[GOLDEN WORKSHEET] '+(e as Error).message);process.exitCode=1}
