# HUM111 pilot: official PDF + YouTube pairing, then 2-lecture RAG test

**Scope:** COMSATS CourseWare **Pakistan Studies (HUM111)**, Dr. Sohail Ahmad, lectures **01–02**.
**Source policy:** Only use the links on the **same** official CCW lesson page. No YouTube transcripts. PDF handout is the sole RAG source. English responses only. Preserve existing voice/text features and seven legacy lectures.

## Confirmed from official material

| No. | Official title | Lesson page | PDF (verified page-1 number/title) |
|---|---|---|---|
| 01 | Ideology of Pakistan | https://ccw.vcomsats.edu.pk/Home/Lesson?LID=NDIwNg%3D%3D | https://ccw.vcomsats.edu.pk/content/HUM111/Handouts/HUM111_Handouts_Lecture01.pdf |
| 02 | Nationalism and Two Nation Theory | https://ccw.vcomsats.edu.pk/Home/Lesson?LID=NDIwNw%3D%3D | https://ccw.vcomsats.edu.pk/content/HUM111/Handouts/HUM111_Handouts_Lecture02.pdf |

The **official** lesson page places the video and PDF together, and the PDF interior heading matches the lesson number/title for both files. This does **not** independently prove the video audio/screen presentation matches all PDF sections. **Do not use a random HUM111 playlist or the separate COMSATS repository series**; their lecture sequences differ.

Source: https://ccw.vcomsats.edu.pk/Home/Course?CID=NA%3D%3D

## Step 1: read-only pairing and extraction preflight

From Ubuntu, after pulling this branch and activating the backend Python venv:

\`\`\`bash
cd ~/askaitutor-pipeline/backend
source .venv/bin/activate
pip install -r scripts/document_requirements.txt
python scripts/preflight_hum111_pilot.py --save-pdfs --out ~/hum111-pilot
\`\`\`

Check \`~/hum111-pilot/preflight.json\`, PDF page counts, text lengths, and warnings. Expected local downloads:

- \`~/hum111-pilot/HUM111_Lecture01.pdf\`
- \`~/hum111-pilot/HUM111_Lecture02.pdf\`

The script never writes to Neon or calls OpenAI/Voyage. YouTube oEmbed is *optional*; if it fails, audio/content alignment remains unchecked. Stop on any title/number mismatch; no silent link fallback.

## Step 2: real app integration, DEVELOPMENT database only

1. Confirm \`backend/.env\` points to Neon **dev-multi-course**, **not production**, and migrations 021+022 are applied.
2. Ensure \`DOCUMENT_EXTRACT_PYTHON\` points to the installed venv Python, S3 upload credentials are configured, and backend \`:5000\` + frontend \`:3000\` are running.
3. In \`/admin/courses\`, create **Pakistan Studies (HUM111)**; don't duplicate an existing course.
4. In \`/admin/lectures/create\`, select that course. Create **Lecture 01: Ideology of Pakistan** and **Lecture 02: Nationalism and Two Nation Theory** with their **official CCW-linked YouTube URLs**, agent name and English-only lecture-specific instructions.
5. In each lecture's Dataset Manager, upload the matching local PDF as its only dataset. Preview warnings and proposed changes. For new empty lectures, MERGE is sufficient. Apply and observe READY/ACTIVE and matching embedding-model readiness.
6. Confirm **the existing Generative AI Fundamentals (7 original lectures)** still loads and has not been modified.
7. Test **independent student questions** below with actual retrieved source-page evidence. The PDF dataset is stored as synthetic source-section labels, **not pre-made Q&A**.

## Step 3: first questions and expected reference areas

| Lecture | Ask | Expected evidence / result |
|---|---|---|
| 01 | What does an ideology explain about the past, present and future? | PDF p.1, section Ideology |
| 01 | Under what circumstances can an ideology emerge? | PDF p.1, Ideology of Pakistan |
| 01 | How is Muslim nationalism related to Pakistan's ideology? | PDF p.2 |
| 01 | What is Lahore's population in 2026? | Not in this lecture; do not guess |
| 02 | What are the main features of nationalism? | PDF p.1 |
| 02 | What is meant by the Two-Nation Theory in this handout? | PDF p.2 |
| 02 | Which factors are associated with Muslim nationhood? | PDF p.3 |
| 02 | What is the 2026 inflation rate? | Not in this lecture; do not guess |

**Caution:** Lecture 01 has a source typo "war of 1957" (historical event is 1857). Record as *source data defect*, not hallucination. Do not use this flawed question as a positive factual-accuracy example.

## Existing architecture and parameters

- PDF page-wise \`pypdf\` extraction is already implemented.
- Document sections: \`RecursiveCharacterTextSplitter\` **1050 chars / 130 overlap**.
- Existing dataset versioning / 1024-d embeddings / pgvector / reranking / grounded answer generation remain unchanged initially.
- **Known warning**: retrieved thresholds tuned for local-http/local-http, but deployed providers openai/voyage. Do not change \`RETRIEVAL_THRESHOLDS_TUNED_FOR\` merely to silence the warning. First evaluate on independent PDF questions and tune.
- Existing \`eval:rag\` / \`tune:thresholds\` default question sampling reads the PDF section's **synthetic source label** as a question. That is **not** a valid PDF RAG accuracy test. Use a human-reviewed question/evidence set to evaluate PDF answers.
- No test is successful until real \`dev-multi-course\` upload, embedding, retrieval and citation checks pass. The repo commit adds a **preflight script**, not an automated live database deployment.

## Subsequent independent milestone

Image question input: MCQ screenshots, scenario screenshots, and lecture-slide/diagram images; English answer + short explanation + genuine PDF-page/lecture references. Existing text and browser voice inputs stay as-is. **Do not block the 2-lecture PDF test on image-input implementation.**

## Permissions

COMSATS grants limited personal noncommercial course-material use. Confirm appropriate approval before institutional/public redistribution. https://ccw.vcomsats.edu.pk/Home/TermsOfUse
