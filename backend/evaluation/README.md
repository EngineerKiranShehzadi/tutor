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

Important: The `hybridIds` ranking is meaningful only when hybrid search is enabled. For vector-only runs, annotate experiment settings separately; **do not** pretend a missing hybrid stage produced results. Output `null` means not measured when the scoring population is absent, not zero quality.

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
