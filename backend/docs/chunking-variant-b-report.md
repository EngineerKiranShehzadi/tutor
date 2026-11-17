# Chunking Variant B: verification and offline A/B report

**Branch:** `codex/canonical-pdf-visual-pilot`  
**Baseline commit:** `1bfa6a900ddb45f7f06661cf41f0cace862d21bd`

## What changed

Variant B keeps format-specific structure through ingestion. Excel Q&A entries remain atomic through 3,200 characters and split only above that limit. Document ingestion emits one logical row per extracted unit, so the chunk planner does not split those rows a second time. DOCX/PDF prose uses a 1,600-character target with 160-character overlap; PPTX slides remain atomic up to 2,200 characters. Document row identities are deterministic and preserve source locations for version planning and sibling chunk families.

The extractor also filters a tiny unstructured DOCX preamble before the first real unit, recognizes Q&A tables only when their headers explicitly identify Question and Answer, cleans PPTX vertical-tab controls and trailing slide-number lines, and groups HTML/TXT content by headings while retaining list and table content.

## Offline A/B results

The benchmark compares the previous chunk settings (A) with Variant B using an offline BM25-style lexical proxy. A retrieval hit requires both the expected source location and recovery of at least 75% of the gold answer tokens in the top five. Excel cases use the workbook's questions and answers. Document cases use deterministic queries and answer spans derived from extracted source text. This is a chunk-boundary screening benchmark, **not** live vector retrieval or a substitute for a production embedding/reranker evaluation.

| Input | Cases | Chunks A → B | Recall@5 A → B | MRR@5 A → B |
|---|---:|---:|---:|---:|
| Lecture 6 Excel Q&A | 410 | 410 → 410 | 99.02% → 99.02% | 94.32% → 94.32% |
| `lec06.docx` | 49 | 38 → 38 | 100% → 100% | 95.58% → 97.96% |
| `Lecture 01(1).pptx` | 23 | 19 → 19 | 100% → 100% | 100% → 100% |
| `HUM111_Lecture01.pdf` | 3 | 8 → 4 | 100% → 100% | 100% → 100% |
| **Combined** | **485** | — | **99.18% → 99.18%** | — |

The lexical benchmark shows no Recall@5 regression in these samples. The PDF produces half as many chunks under B while keeping the same source-span retrieval results. The DOCX MRR@5 improves in this proxy. These results are limited by the small, source-derived document query sets and lexical scoring; they do not prove embedding-space gains.

## Required edge checks

- DOCX short preamble fragments such as `tea` are filtered before standalone chunk creation.
- DOCX `Prompt: … / AI Response: …` evaluation tables are not reclassified as `Question:` / `Answer:` rows.
- Repeated slide headings/questions receive deterministic document IDs and `matchRows()` accepts them under both `MERGE` and `REPLACE`.
- Rows already produced by `documentToRows()` are passed as document chunks and are not split once in ingestion and again by the generic planner.
- Excel Q&A rows up to 3,200 characters remain a single chunk (`chunk_index = 0`).
- PPTX slides under 2,200 body characters remain one chunk; standalone trailing slide numbers and vertical-tab control characters are removed.
- HTML and TXT extraction creates heading/section-scoped units while retaining lists and tables in the extracted content.

## Verification

| Check | Result |
|---|---|
| TypeScript typecheck (`npm run typecheck`) | Passed |
| Extractor tests (`python scripts/test_extract_document.py`) | 20/20 passed |
| Visual document tests (`python scripts/test_visual_document.py`) | 5/5 passed |
| Document ingestion/planner checks (`test-document-ingestion.ts`) | Passed |
| Offline A/B benchmark | 485 cases completed; 0 extraction/evaluation failures |
| `git diff --check` | Passed |

The full backend runner cannot complete in this environment because PostgreSQL is not listening at `127.0.0.1:5432`; Docker/PostgreSQL are unavailable here. Phoenix is also unavailable, so trace-export checks cannot exercise a live Phoenix endpoint. The existing DB/Phoenix-dependent failures were reproduced against the clean baseline commit. Other pre-existing failures were also checked against that baseline: `test-rag-defects.ts` remained 39/54, `test-monitor.ts` remained 29/30, `test-trace-ids.ts` remained 9/13, and the direct Node test harness had the same pass/fail counts on baseline and Variant B. These failures are outside the changed chunking/extraction modules.

The benchmark and focused tests use local sample files. No `.env` or secret was changed. The embedding model (`text-embedding-3-small`, 1024 dimensions), hybrid search (`RRF_K=60`), and Voyage `rerank-3` configuration were not changed.

## Reproduce the offline A/B run

From `backend/`:

```bash
DB_PASSWORD=local-test-only \
JWT_SECRET=local-test-jwt-secret-for-offline-evaluation-1234 \
JWT_REFRESH_SECRET=local-test-refresh-secret-for-offline-evaluation-1234 \
./node_modules/.bin/ts-node --transpile-only src/scripts/evaluate-chunking-variants.ts \
  "$HOME/Downloads/Final-merged-dataset/Lecture_06_Final_Dataset_Merged_File.xlsx" \
  "/path/to/lec06.docx" \
  "/path/to/Lecture 01(1).pptx" \
  "/path/to/HUM111_Lecture01.pdf"
```
