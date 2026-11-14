# Faculty Learning-Gap Dashboard (English-only)

## Scope
Implemented as an additive admin-only GraphQL aggregate and a theme-consistent page under `/admin/faculty-gaps`. It uses **completed, explicitly faculty-mapped** quiz answers already stored in PostgreSQL. It does not rerun AI, generate quizzes, or alter RAG.

## Descriptive rules
- Student receives a per-CLO categorization only from graded quiz evidence. This new cohort page does not receive student IDs.
- A learner must have **at least 3** mapped graded answers for that CLO to enter the sufficient-evidence cohort.
- The dashboard hides all cohort scores and counts until **5** students are sufficiently assessed.
- Only when the threshold is reached, an observed wrong-answer proportion >40% in 30% or more of sufficiently assessed learners triggers *faculty review recommended*.
- A review recommendation is **not** an early-warning prediction, diagnosis, grade or automatic teaching action.
- Unmapped questions and quizzes do not provide outcome evidence.
- Instructor privileges are not course-scoped yet; this page is **ADMIN-only**, not multi-university safe.

## Remaining release gates
- Faculty mapping UX review and real classroom validation
- Browser acceptance with course changes, empty state, permission denial, small-cohort privacy
- Load test and accurate cohort denominator confirmation with production-like anonymized fixtures
- Course-scoped faculty authorization, organization isolation and institutional review before real multi-university rollout
- No production Neon migration or deployment performed.

## Engineering references
- 1EdTech Caliper Analytics: https://www.1edtech.org/standards/caliper
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
