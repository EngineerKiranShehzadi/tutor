# Faculty-approved personalized revision (English-only)

One plan per course learning outcome (CLO); draft is private to admins. An approved plan references a non-archived lecture explicitly mapped to that CLO. Students only receive guidance if their **own** completed faculty-mapped quiz results contain >=3 graded responses and <60% correctness for that CLO.

No automatic quiz creation, academic status prediction, exam grading, notifications, or LMS integration. A student **chooses** when to open the lecture and when to request another practice quiz.

Endpoint access: admin-only create/approve/withdraw/list; student-only self-scoped recommendations. No student IDs returned to other students. Existing theme variables reused.

Deployment: migration 036 depends on 033 learning outcomes and 022 courses/023 quizzes. Do not apply 033–036 on live Neon without a fresh verified backup and staged functional testing. Automated tests in disposable Postgres are not browser or live-learning validation.
