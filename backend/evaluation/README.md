# Golden RAG benchmark — English-only / offline evaluation v1

This is an **evidence-labelled evaluation harness**, not a new generation pipeline. It never calls an API or touches Neon. Existing `evaluate-rag.ts` is retained for experimentation, but its random questions cannot be compared reproducibly across runs.

## Faculty gold-label contract

Create a private (not committed) `gold.json` with `{"schemaVersion":1,"cases":[...]}`. Each case requires:

- `id`: stable unique string, `lectureId`, **pinned** `datasetVersionId`
- `question` in English; `category`: factual / conceptual / comparison / compound / follow_up / unsupported / ambiguous / keyword / paraphrase
- `answerable`: boolean; `expectedChunkIds`: faculty-reviewed positive integer IDs. An unsupported case must use `[]`.
- `reviewed:true`, `reviewedBy`: who verified the gold labels (use a non-sensitive identifier).

Use **20–30 reviewed questions per representative lecture**. Include unsupported and compound cases. Snapshot the active dataset version and never silently rewrite evidence IDs.

## Predictions

Save a matching `predictions.json` containing `schemaVersion:1` and `cases` with:
`id,lectureId,datasetVersionId,vectorIds,hybridIds,rerankedIds,finalContextIds,citationChunkIds,refused,latencyMs,human`.

Each `*Ids` is a **ranked list of actual retrieved chunk IDs**, captured from a measured execution, not a simulated ranking. `human` is `{"answerCorrect":"UNREVIEWED","grounded":"UNREVIEWED","citationValid":"UNREVIEWED"}` until independent review. Never label these PASS from the system verifier without an actual human check.

Each case may also carry an **optional** `dedupSelectionIds` — the reranked pool after answer-dedup and the relevance floor, *before* the context budget. It sits between `hybridIds` and `rerankedIds`. It is validated only when present and is scored (as the `dedupSelection` stage) **only when every case carries it**, so older prediction files score byte-for-byte the same. Keep the distinction: `rerankedIds` is the full reranker ranking; `dedupSelectionIds` is what survives dedup + floor; `finalContextIds` is the ≤5 actually eligible for context.

Important: The `hybridIds` ranking is meaningful only when hybrid search is enabled. For vector-only runs, annotate experiment settings separately; **do not** pretend a missing hybrid stage produced results. Output `null` means not measured when the scoring population is absent, not zero quality.

## Capturing predictions from a live run (no manual ranking entry)

`src/scripts/capture-rag-predictions.ts` runs the real retrieval pipeline against each case's **pinned** `datasetVersionId` and writes a `predictions.json` the evaluator can score. It reuses the production retrieval/rerank functions (never a re-implementation) and runs raw-vector and hybrid as **separate explicit executions**, so the deployed hybrid path is never mislabelled as raw-vector. Run it only after that corpus version has finished embedding + indexing.

```bash
cd backend
npm run capture:rag -- /private/gold.json /private/predictions.json      # [--candidate-limit=15] [--final-context=5]
```

It captures all five ranked stages (`vectorIds`, `hybridIds`, `dedupSelectionIds`, `rerankedIds`, `finalContextIds`), plus `refused`, `latencyMs`, and a top-level `meta` pinning the embedder/reranker model versions and retrieval config for reproducibility. By default it leaves `citationChunkIds` empty and all `human` verdicts `UNREVIEWED`, so nothing is silently scored as a pass. Needs Postgres + the configured embedding/reranker providers; a per-case failure is recorded on that case and the run continues.

Add `--answer` to also generate the grounded answer for each case (same context + ordering as production) and store it on the case for human review:

```bash
npm run capture:rag -- /private/gold.json /private/predictions.json --answer
```

With `--answer`, `citationChunkIds` is set to the final-context chunk IDs. The tutor does not emit per-sentence citation markers — the chunks an answer is grounded in *are* its final context — so citation precision/recall here measures whether the context the answer used carried the expected evidence; it is not a finer-grained per-claim citation check. Answer correctness and grounding remain **human** verdicts (`answerCorrect`, `grounded`), still `UNREVIEWED` until a reviewer sets them; `--answer` only produces the text to review. Requires the configured answer LLM provider in addition to embeddings/reranker.

Add `--judge` (which implies `--answer`) to also run an optional LLM-as-judge:

```bash
npm run capture:rag -- /private/gold.json /private/predictions.json --judge
```

The judge scores grounding (answer vs the final-context chunks) and, when the gold case carries an `expectedAnswer`, correctness (answer vs reference). Its verdicts are stored on each case under a separate `judge` field — never in `human` — and the evaluator aggregates them in a separate `judge` section, computed only over cases that carry a judge verdict and excluding `UNKNOWN`. **The judge is an aid only: it is never a gold label and never gates approval or release** (`exportApprovedGold` and "Approve & Go Live" stay human-driven). The judge model and prompt version are recorded in the predictions `meta`. Requires the configured judge LLM (`LLM.ANSWER_VERIFICATION.MODEL`).

## Run

```bash
cd backend
node --test evaluation/golden-evaluator.test.cjs
node evaluation/golden-evaluator.cjs /private/gold.json /private/predictions.json /private/new-report.json
```

The report gives Recall@5/15, MRR, nDCG@5 for available ranked lists, citation precision/recall (only where a relevant gold set exists), unsupported refusal rate, false refusal rate, reviewed answer/grounding/citation pass rates, p50/p95 latency and sample counts. These measures evaluate **labelled retrieval/response evidence**, not proof of learning gains.

**Security:** Never add raw student questions/answers, names, emails, or production telemetry to GitHub. Collect evaluation cases with consent and redact PII. Run test capture using read-only scope and separate credentials; production writes are prohibited.

## Evaluation design references

- Ragas metrics: https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/
- RAG evaluation review (2026): https://link.springer.com/article/10.1007/s42979-026-05134-x

## Next increments (not implemented yet)
1. Read-only capture adapter from *actual* request-level retrieval spans with consistent question IDs, session ID de-identification, and dataset-version pinning.
2. Faculty review workflow for reference chunks and answer/citation judgments.
3. Side-by-side vector-only vs hybrid+rerank datasets (identical questions and versions).
4. Longitudinal regression dashboard without exporting student PII.
