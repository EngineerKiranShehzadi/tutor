# Threshold tuning — ep-still-bread-apuyjxwm.c-7.us-east-1.aws.neon.tech:5432/neondb

- Embedding: `openai:text-embedding-3-small:1024` · Reranker: `voyage:rerank-3`
- In-scope questions: **35** over 7 lecture(s) (2, 4, 5, 6, 7, 8, 9), up to 5 per lecture, seed 42
- Question wording: **exact dataset questions** — exact dataset questions inflate similarity; treat the in-scope numbers as an upper bound
- Out-of-scope questions: **35** (35 cross-lecture, 0 from file)
- Constraint: out-of-scope false-accept ≤ 5.0% · feasible pairs: 38 of 247

## Recommendation

`VECTOR_SIMILARITY_THRESHOLD=0.75` and `RERANK_MIN_SCORE=0.90`

| vector θ | rerank floor | in-scope success | in-scope not-found | in-scope wrong | out-of-scope false-accept | OOS refused by vector / rerank | in-scope not-found by vector / rerank |
|---|---|---|---|---|---|---|---|
| 0.75 | 0.90 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |

## Current values

| vector θ | rerank floor | in-scope success | in-scope not-found | in-scope wrong | out-of-scope false-accept | OOS refused by vector / rerank | in-scope not-found by vector / rerank |
|---|---|---|---|---|---|---|---|
| 0.55 | 0.50 | 100.0% | 0.0% | 0.0% | 31.4% | 16 / 8 | 0 / 0 |

The current pair (`0.55` / `0.5`) is **not feasible**: false-accept 31.4% > 5.0%.

## Best feasible pairs (top 10)

| vector θ | rerank floor | in-scope success | in-scope not-found | in-scope wrong | out-of-scope false-accept | OOS refused by vector / rerank | in-scope not-found by vector / rerank |
|---|---|---|---|---|---|---|---|
| 0.75 | 0.90 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.85 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.80 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.75 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.70 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.65 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.60 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.55 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.50 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |
| 0.75 | 0.45 | 74.3% | 25.7% | 0.0% | 2.9% | 34 / 0 | 9 / 0 |

## Reading this

- **Refused by vector** = no candidate reached the similarity threshold (`NO_VECTOR_CANDIDATES`); **by rerank** = candidates reached the reranker but none cleared the floor (`ALL_CANDIDATES_BELOW_RERANK_FLOOR`).
- **In-scope wrong** = something was returned but not the gold Q&A. Success needs the gold Q&A in the final top-5 above the floor.
- Cross-lecture negatives come from the same course, so a question from lecture A can be legitimately answerable in lecture B: false-accept is a conservative upper bound. Add an `--oos` file of genuinely unrelated questions to tighten it.
- The out-of-scope set has 35 questions, so false-accept moves in steps of 2.9%; ties are broken toward the safer (higher) thresholds.
