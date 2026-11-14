import {query} from '../config/database';
import type {QnaChunk} from '../types';

/** Conservative context expansion for existing and newly uploaded datasets.
 * Every neighbor MUST share the same lecture and pinned dataset version.
 * - Existing Excel rows and long answers use stable dataset_version_chunks.qa_id.
 * - DOCX/PDF question children use exact question + source locator.
 * - Prose children use synthetic "Part N" with adjacent part numbers.
 * Never expand across pages, unrelated questions, or unapproved versions.
 * Added candidates must still satisfy the ordinary reranker relevance floor.
 */
export function contextFamilyKey(chunk: Pick<QnaChunk,'question'|'start_time'>): string|null {
 const q=(chunk.question??'').trim();
 const locator=(chunk.start_time??'').trim();
 if(!q || !locator)return null;
 if(q.startsWith('Source excerpt:')){
  const base=q.replace(/ \| (?:Part|Visual) \d+$/,'');
  if(base===q)return null;
  return locator+'|'+base;
 }
 return locator+'|Q:'+q.replace(/\s+/g,' ').toLowerCase();
}
export function boundedNewNeighbors<T extends {id:number}>(original:readonly T[],neighbors:readonly T[],cap:number):T[]{
 if(cap<=0)return [];
 const seen=new Set(original.map(r=>r.id));
 const result:T[]=[];
 for(const row of neighbors){
  if(seen.has(row.id))continue;
  seen.add(row.id);result.push(row);
  if(result.length>=cap)break;
 }
 return result;
}
export async function expandContextCandidates(
 candidates:QnaChunk[],lectureId:number,topK:number,datasetVersionId?:number
):Promise<QnaChunk[]> {
 if(!candidates.length || topK<1)return candidates;
 const anchors=candidates.slice(0,Math.min(6,topK));
 const maxExtras=Math.min(8,Math.max(2,Math.floor(topK/2)));
 const ids=anchors.map(x=>x.id);
 const {rows}=await query<QnaChunk>(`
 WITH anchors AS (
   SELECT d.qa_id,c.id,c.question,c.start_time,d.chunk_index,
     regexp_replace(c.question,'[|] (Part|Visual) [0-9]+$','') AS section_name,
     CASE WHEN c.question ~ '[|] (Part|Visual) [0-9]+$'
       THEN substring(c.question FROM '([0-9]+)$')::int ELSE NULL END AS part_number
   FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id=d.chunk_id
   WHERE d.version_id=COALESCE($3::int,(SELECT active_version_id FROM lectures WHERE id=$1))
     AND c.lecture_id=$1 AND c.id=ANY($2::int[])
 ), neighbors AS (
   SELECT DISTINCT ON (c.id) c.id,c.lecture_id,c.topic,c.question,c.answer,
     c.chunk_text,c.chunk_index,c.start_time,c.end_time,c.keywords,
     LEAST(ABS(d.chunk_index-a.chunk_index),3) AS distance
   FROM anchors a
   JOIN dataset_version_chunks d ON d.version_id=COALESCE($3::int,(SELECT active_version_id FROM lectures WHERE id=$1))
   JOIN lecture_qna_chunks c ON c.id=d.chunk_id AND c.lecture_id=$1
   WHERE c.id<>a.id AND c.local_embedding IS NOT NULL
     AND (
       (d.qa_id=a.qa_id AND a.qa_id IS NOT NULL)
       OR (a.start_time IS NOT NULL AND c.start_time=a.start_time
           AND c.question=a.question AND c.question NOT LIKE 'Source excerpt:%')
       OR (a.part_number IS NOT NULL
           AND c.start_time=a.start_time
           AND c.question LIKE 'Source excerpt:%'
           AND regexp_replace(c.question,'[|] (Part|Visual) [0-9]+$','')=a.section_name
           AND c.question ~ '[|] (Part|Visual) [0-9]+$'
           AND ABS(substring(c.question FROM '([0-9]+)$')::int-a.part_number)<=1)
     )
   ORDER BY c.id,LEAST(ABS(d.chunk_index-a.chunk_index),3)
 )
 SELECT id,lecture_id,topic,question,answer,chunk_text,chunk_index,
   start_time,end_time,keywords FROM neighbors ORDER BY distance,id LIMIT $4`,
 [lectureId,ids,datasetVersionId??null,maxExtras]);
 return [...candidates,...boundedNewNeighbors(candidates,rows,maxExtras)];
}
