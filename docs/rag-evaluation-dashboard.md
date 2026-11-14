# Admin RAG evaluation dashboard — evidence-only v1

The admin console includes **RAG Evaluation**. Admins can submit a faculty-reviewed golden JSON and a recorded predictions JSON following `backend/evaluation/README.md`. The backend recomputes all aggregates with the existing Golden RAG evaluator, validates lecture-version pairing, rejects duplicate case IDs, refuses unreviewed golden labels and refuses sets smaller than 10 cases or without unsupported examples.

`037_rag_benchmark_runs.sql` persists only aggregates, counts, dataset scopes and SHA-256 fingerprints. It does **not** persist the raw golden questions, prediction text, student names, or trace contents. The upload is admin-only and not available to students.

**Current limitation:** This is a reporting/import feature. No new live retrieval capture, faculty adjudication interface or pre/post educational study is implemented. Real measured benchmark values will only appear after valid real offline evaluation data is provided. The dashboard does not fabricate results or infer effectiveness from chat counts.

**Safety:** Do not upload personally identifiable information, production conversations, or confidential lecture material into benchmark inputs. No live production migration has been run. Migration 037 depends on prior migrations. Only deploy after isolated and staging verification.
