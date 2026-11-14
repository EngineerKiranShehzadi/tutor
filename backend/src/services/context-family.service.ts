import {query} from '../config/database';
import type {QnaChunk} from '../types';

/**
 * Only expand neighbors belonging to the same pinned dataset version and
 * same lecture. Prefer the immutable Q&A identity (d.qa_id). Word/PDF child
 * rows are distinct Q&As; for those use the SAME explicit original question
 * and source locator. Synthetic prose chunks may include immediately adjacent
 * parts of the same source section, but never an arbitrary different page.
 *
 * Expansion happens BEFORE reranking, and added chunks are NOT treated as
 * evidence until they independently pass the reranker threshold.
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
   SELECT d.qa_id,c.id,c.question,c.start_time,c.chunk_index,
     regexp_replace(c.question,' \\| (Part|Visual) [0-9]+$','') AS section_name,
     c.lecture_id
   FROM dataset_version_chunks d JOIN lecture_qna_chunks c ON c.id=d.chunk_id
   WHERE d.version_id=COALESCE($3::int,(SELECT active_version_id FROM lectures WHERE id=$1))
     AND c.lecture_id=$1 AND c.id=ANY($2::int[])
 ), neighbors AS (
   SELECT DISTINCT ON (c.id) c.id,c.lecture_id,c.topic,c.question,c.answer,
     c.chunk_text,c.chunk_index,c.start_time,c.end_time,c.keywords,
     ABS(c.chunk_index-a.chunk_index) AS distance
   FROM anchors a
   JOIN dataset_version_chunks d ON d.version_id=COALESCE($3::int,(SELECT active_version_id FROM lectures WHERE id=$1))
   JOIN lecture_qna_chunks c ON c.id=d.chunk_id AND c.lecture_id=$1
   WHERE c.id<>a.id AND c.local_embedding IS NOT NULL
     AND (
       d.qa_id=(SELECT v.qa_id FROM dataset_version_chunks v
                WHERE v.version_id=d.version_id AND v.chunk_id=a.id LIMIT 1)
       OR (a.start_time IS NOT NULL AND c.start_time=a.start_time AND
           c.question=a.question AND c.question NOT LIKE 'Source excerpt:%')
       OR (a.question LIKE 'Source excerpt:%'
           AND c.question LIKE 'Source excerpt:%'
           AND c.start_time=a.start_time
           AND regexp_replace(c.question,' \\| (Part|Visual) [0-9]+$','')=a.section_name
           AND ABS(c.chunk_index-a.chunk_index)<=1)
     )
   ORDER BY c.id,ABS(c.chunk_index-a.chunk_index)
 )
 SELECT id,lecture_id,topic,question,answer,chunk_text,chunk_index,
   start_time,end_time,keywords FROM neighbors ORDER BY distance,id LIMIT $4`,
 [lectureId,ids,datasetVersionId??null,maxExtras]);
 return [...candidates,...boundedNewNeighbors(candidates,rows,maxExtras)];
}
