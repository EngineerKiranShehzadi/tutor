# University-ready learning architecture (Phase 1, English-only)
**Source branch:** `feature/adaptive-learning-foundation` forked from YouTube MVP `5e7642a`.

## Currently implemented
- Faculty/admin creates stable Course Learning Outcome (CLO) codes and descriptions.
- Explicit lecture-to-CLO mapping for revision recommendations; mapping a lecture does **not** assert all its quiz questions cover that CLO.
- Faculty tags existing generated quiz questions to CLOs after reviewing them.
- Student outcome progress counts only correct/incorrect **submitted** answers to **explicitly tagged** quiz questions; no invented mastery from chat volume or untagged quizzes.
- Summary indicators: not assessed; fewer than three graded items = insufficient evidence; 80%+ strong; 60%+ developing; otherwise revision suggested. These are descriptive, not certified psychometric mastery measurements.
- Faculty aggregates per CLO (attempts, correct, distinct student count). No individual student names in this aggregate API.
- Same existing CSS theme variables; no new language, no new quiz generation triggers.
- `033_learning_outcomes.sql` is additive. **Do not run on live Neon without an independently verified backup and rollout approval.**

## LMS architecture boundary (NOT integrated)
Core RAG / quiz / datasets must remain university-neutral.
Future adapters should live behind `LmsToolAdapter` in `backend/src/integrations/lms/contracts.ts`:

| Concern | Owned by | Safety requirement |
| --- | --- | --- |
| Institutional identity | Future LTI 1.3 adapter | Verify issuer, audience, JWT signature, deployment ID, OIDC state/nonce and expiration |
| Local authentication | Existing app | Do not replace or bypass standalone sign-in until verified LTI is approved |
| Course registration | Registry/tenant resolver (future) | Resolve trusted platform course IDs to local course IDs; no cross-university leakage |
| Role management | Authorization layer (future) | Instructor is scoped to authorized courses; existing ADMIN is global |
| CLO interoperability | Future CASE consumer/import | Bind external CASE GUID to faculty-approved outcome; never overwrite without conflict review |
| Grade passback | Future LTI Advantage AGS adapter | Explicit consent and scoped endpoints; not automatic |
| Roster access | Future LTI NRPS adapter | Least-privilege, institution-approved enrollment |
| Data retention | University privacy policy | Per-university retention and deletion rules require approval |
| Tenant isolation | Future organization ID + RLS | Add organization relations, unique constraints and tests **before** multi-university deployment |

**No COMSATS LMS API credentials, connector, student roster or live LMS session are configured.**
Do not enable multi-institution deployment with today's shared-role design.

## Validation gates before real university rollout
1. Multi-university isolation and role tests, including cross-course instructor denial and cross-student access.
2. LTI conformance tests with university-owned staging LMS and signed launch fixtures.
3. English-only data/prompt safety, document licensing and captions policy.
4. WCAG 2.2 AA keyboard, contrast, status-message and screen-reader acceptance.
5. >100-student load exercise with database isolation, concurrent quiz and RAG latency/p95 metrics.
6. Retrieval and evidence evaluation by faculty: Precision@k, Recall@k, grounded-answer accuracy, unsupported-claim rate, valid citations and refusal accuracy.
7. Gradebook/outcome accuracy on labeled quiz fixtures; no grade export from inferred progress.
8. Pilot approval by COMSATS LMS/security administrator before any real integration.

## Source standards
- 1EdTech LTI: https://www.1edtech.org/standards/lti
- 1EdTech CASE: https://www.1edtech.org/standards/case
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
