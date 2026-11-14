import { query } from '../config/database';
import { logger } from '../utils/logger';
import type { QnaChunk } from '../types';

/** Context neighbors must belong to the same lecture and pinned dataset version.
 * Added candidates still pass through the independent relevance reranker. */
export function contextFamilyKey(chunk: Pick<QnaChunk,'question'|'start_time'>):string|null {
 const q=(chunk.question??'').trim(),loc=(chunk.start_time??'').trim();
 if(!q||!loc)return null;
 if(q.startsWith('Source excerpt:')){
  const base=q.replace(/ \| (?:Part|Visual) \d+$/,'');
  return base===q?null:loc+'|'+base;
 }
 return loc+'|Q:'+q.replace(/ \[Answer part \d+\]$/,'').replace(/\s+/g,' ').toLowerCase();
}
export function boundedNewNeighbors<T extends {id:number}>(original:readonly T[],neighbors:readonly T[],cap:number):T[]{
 if(cap<=0)return [];
 const seen=new Set(original.map(r=>r.id)),out:T[]=[];
 for(const r of neighbors){if(seen.has(r.id))continue;seen.add(r.id);out.push(r);if(out.length>=cap)break;}
 return out;
}
export async function expandContextCandidates(
 candidates:QnaChunk[],lectureId:number,topK:number,datasetVersionId?:number
):Promise<QnaChunk[]>{
 if(!candidates.length||topK<1)return candidates;
 const ids=candidates.slice(0,Math.min(6,topK)).map(c=>c.id);
 const cap=Math.min(8,Math.max(2,Math.floor(topK/2)));
 try {
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
    ABS(d.chunk_index-a.chunk_index) AS distance
   FROM anchors a
   JOIN dataset_version_chunks d ON d.version_id=COALESCE($3::int,(SELECT active_version_id FROM lectures WHERE id=$1))
   JOIN lecture_qna_chunks c ON c.id=d.chunk_id AND c.lecture_id=$1
   WHERE c.id<>a.id AND c.local_embedding IS NOT NULL AND (
     (a.qa_id IS NOT NULL AND d.qa_id=a.qa_id)
     OR (a.start_time IS NOT NULL AND c.start_time=a.start_time
       AND c.question NOT LIKE 'Source excerpt:%'
       AND (c.question=a.question OR (
        position(' [Answer part ' in c.question)>0
        AND position(' [Answer part ' in a.question)>0
        AND split_part(c.question,' [Answer part ',1)=split_part(a.question,' [Answer part ',1)
       )))
     OR (a.part_number IS NOT NULL AND c.start_time=a.start_time
       AND c.question LIKE 'Source excerpt:%'
       AND regexp_replace(c.question,'[|] (Part|Visual) [0-9]+$','')=a.section_name
       AND c.question ~ '[|] (Part|Visual) [0-9]+$'
       AND ABS(substring(c.question FROM '([0-9]+)$')::int-a.part_number)<=1)
   )
   ORDER BY c.id,ABS(d.chunk_index-a.chunk_index)
 )
 SELECT id,lecture_id,topic,question,answer,chunk_text,chunk_index,
  start_time,end_time,keywords FROM neighbors ORDER BY distance,id LIMIT $4`,[lectureId,ids,datasetVersionId??null,cap]);
 return [...candidates,...boundedNewNeighbors(candidates,rows,cap)];
 } catch {
  // Context expansion is auxiliary; never make an otherwise-valid RAG search
  // unavailable if this new optional query fails in a partially migrated DB.
  logger.warn('[CONTEXT EXPANSION] Supplemental neighbor query failed; using original reranked candidate pool');
  return candidates;
 }
}
