# Context-preserving document ingestion (FYP)

## Scope
All lecture uploads keep existing immutable dataset versions, content-hash embedding reuse, admin dry-run, merge/replace, and rollback. New source files are not overwritten. CLO documents are extracted as structured learning objectives separately from answer evidence.

## Parsing and chunking
- DOCX: split by real Word heading and explicit slide labels; preserve Word table row/cell association. Detect Question/Answer tables.
- PPTX: preserve slide units and detect Q&A table rows.
- PDF: preserve each page as source location; use text extraction and existing optional visual enrichment.
- Excel: preserve existing logical Q&A rows and their topic/question prefixes.
- Text/HTML: use existing normalized text source, split with section/paragraph preferences.
- Explicit Question/Answer or short standalone questions become logical Q&A groups. Children carry the original question and section heading. Incomplete explicit Q&A labels fail closed instead of silently splitting. Ordinary MCQ option labels (e.g., A.) are not interpreted as answer labels.
- Long prose preserves section title on child chunks when available. Soft splitting is bounded by a 1050-character target with overlap.
- Any dataset row exceeding the existing 20-child safety cap appears in dry-run, but the apply step refuses publication to prevent dropped material.

## Retrieval
- Vector-only and hybrid retrieval keep their existing first-stage selection.
- Up to 6 anchored candidates may retrieve at most 8 related context pieces.
- Relationships are limited to the same lecture AND the pinned active/version ID; old Excel Q&A uses qa_id, Word/PDF long answer parts use stable question/locator labels, prose uses adjacent source Part numbers.
- Expanded pieces pass the same reranker. They do not bypass the relevance threshold, answer-memory checks, answer verifier, or source citations.
- Auxiliary context-query faults fall back to the original candidate set and are logged.

## Quality and admin
- Upload dry-run exposes source section count, source text character count, Q&A groups, child pieces, prose/visual pieces, and extraction warnings. It does NOT claim a verified semantic coverage or correctness percentage.
- Selecting MERGE preserves old rows. For a corrected Word/PDF/PPT source replacing broken old sections, choose REPLACE and verify the exact removal confirmation. Existing active dataset remains available until the replacement finishes and activates.
- Historical versions remain available for rollback.

## Verification
Run these before reupload:
```bash
cd backend
npm run typecheck
npx ts-node --transpile-only src/scripts/test-document-ingestion.ts
npx ts-node --transpile-only src/scripts/test-context-family.ts
python3 scripts/test_extract_document.py
cd ../frontend
npm run typecheck
```
The GitHub Actions learning-outcomes workflow now includes the above ingestion regressions and type checks. A live end-to-end test with the user's actual Word lecture is still required before claiming production readiness: preview semantic groups, apply a disposable or development copy, query known definition + example pairs, check citation coverage and verify no orphaned answers. The real source material has not been provided to the implementer in this conversation.

## Limits
No chunking algorithm can guarantee 100% correct answers. PDF layout, complex tables, diagrams and implied relationships are not fully reconstructible from plaintext. Semantic chunk coherence is heuristically preserved, with bounded neighbor expansion; AI-based content restructuring is deliberately avoided to prevent invented educational facts. Embeddings only regenerate for changed text under the existing incremental pipeline.
