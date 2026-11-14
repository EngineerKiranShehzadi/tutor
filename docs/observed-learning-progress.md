# Observed learning progress (English-only)

The Student Learning Outcomes page compares the **first and latest chronological completed quizzes** for each CLO where both quizzes contain at least 3 faculty-tagged, graded answers. The server reads only the authenticated student's `practice_quizzes`/`practice_answers` records and the explicitly mapped `practice_question_outcomes`.

* A minimum of two distinct qualifying quizzes is required; otherwise results are `null` / "More comparable quiz evidence needed".
* Change is **latest percentage minus first percentage**, in percentage points. A negative score is shown honestly.
* Source mapping is faculty-maintained and may change retroactively; a future research study must snapshot item/CLO mappings.
* Quiz items can differ in difficulty, time, content exposure and motivation. This metric is **observational**, **not** a controlled pre/post test, causal AI effect estimate, validated mastery measurement or grade.
* No new quiz is generated automatically; formal quizzes remain entirely student-initiated.
* No database migration required. Existing RAG, AI/guardrails and stored embeddings are unaffected.
* Do not call this "measured effectiveness of AI tutoring" before a prospective study with faculty-equated forms, time-matched participants and verified outcomes.

Research design references: IES What Works Clearinghouse Procedures Handbook; educational measurement and testing guidance.
