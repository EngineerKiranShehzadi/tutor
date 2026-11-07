# Multi-format course material ingestion

Branch: \`feature/multi-format-ingestion\` (based on \`feature/integration\`).

## Supported sources

The existing \`.xlsx\` Q&A path is preserved. The same **Admin > Lecture > Dataset Manager** upload endpoint accepts \`.pdf\`, \`.docx\`, \`.pptx\`, \`.txt\`, \`.html\`, and \`.htm\`.

**No Q&A spreadsheet is needed for documents.** The backend extracts selectable text locally, splits it into source-labelled sections, then feeds those sections through **the unchanged versioned dataset builder, embedding provider, pgvector, reranker, and answer verification**.

| Format | Extraction | Source location |
|---|---|---|
| XLSX | Existing SheetJS Q&A parser (unchanged) | Existing source reference |
| PDF | Python pypdf, page by page | Page N |
| DOCX | python-docx paragraphs and tables | Document |
| PPTX | python-pptx slide text and table cells | Slide N |
| TXT | UTF-8 text, normalized | Document |
| HTML/HTM | Beautiful Soup, without script/style/nav/footer/iframe | Document |

This is **direct extraction**, not a PDF-to-Word conversion. No files are sent to conversion sites. The extraction process runs locally with timeout and file limits. Legacy \`.doc\`, \`.ppt\`, \`.epub\`, scanned files and YouTube URLs are intentionally unsupported. They may be added later with dedicated importers or **approved** local conversion.

## Installation (development/deployment)

The Node backend requires Python 3.10+ with these packages installed in an isolated environment:

\`\`\`bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r scripts/document_requirements.txt
# The backend process must use the venv Python executable.
export DOCUMENT_EXTRACT_PYTHON="$PWD/.venv/bin/python"
npm run dev
\`\`\`

\`DOCUMENT_EXTRACT_PYTHON\` is optional when \`python3\` and all dependencies are already on the backend host's PATH. It does **not** configure an external API.

For real questions, ensure your environment has the **matching active embedding model and tuned reranker thresholds**; review \`docs/OPENAI_SWITCH.md\`. **Do not run migrations or tests against production Neon without owner approval.**

## How to try it

1. Create a fresh lecture with the existing admin interface.
2. On its Dataset Manager page, choose a **text-based** PDF (or a DOCX/PPTX/TXT/HTML file) under 10 MB.
3. Click upload. The UI performs a **dry-run preview**: added/updated/kept/removed sections, and any extraction warnings.
4. Review the preview, choose MERGE (default) or REPLACE (explicit confirmation for deletions), and apply.
5. Wait for the version to reach ACTIVE. The existing builder resumes interrupted embedding work and never replaces the currently active version until validation succeeds.
6. Open the lecture and ask a question about a specific page/slide. Review the answer and cited sources.

**Important for a new document**: A document source can be uploaded into a lecture that already contains Excel data using MERGE. The old Q&A records remain live. To completely replace the lecture's dataset, choose REPLACE and confirm the exact number of removals.

**Important for edits to an existing document**: Stable question labels are derived from **filename + page/slide + section number**. Re-uploads with the same filename update matching sections. When a revised document becomes *shorter*, MERGE retains sections not present in the new file. Use REPLACE (after reviewing the removal preview) for a lecture that is meant to contain **only the new document**. True per-file replacement inside multi-document lectures needs a future source-ID migration. Do not claim that case is already solved.

## Document vs Q&A representation

The current schema stores \`question\`, \`answer\`, \`chunk_text\`, \`start_time\`, and \`qa_id\`. To keep the existing RAG pipeline and migrations intact, each extracted section is represented as:

- \`question\`: **Source excerpt: book.pdf | Page 3 | Part 2** (synthetic source label, NOT a model-generated question).
- \`answer\`: verbatim text from that page/slide section, typically 1,050 chars maximum, with 130 chars overlap.
- \`start_time\`: **book.pdf | Page 3** (source locator, not a video timestamp).
- \`qa_id\`: assigned by the existing versioned dataset builder.

The existing Q&A row format remains unchanged. The RAG answer generator sees the section text in \`chunk_text\`, even though the database column happens to be named \`answer\`. This is a compatibility layer rather than a dedicated document-first schema. For a long-term product, a \`knowledge_sources\` table with a source ID and typed page/slide metadata would be a cleaner model.

## Limits and safety

- **10 MB file upload limit** (shared with existing XLSX setting); Python rejects larger inputs and empty files.
- **Office ZIP checks**: at most 500 entries, at most 20 MB expanded, at most 10 MB per entry; rejects encrypted archives.
- **PDF max 500 pages; PPTX max 500 slides**, and extracted text capped to 900,000 characters.
- **At most DATASET_MAX_ROWS (default 1,000) document sections** per upload; oversized documents must be split.
- **30-second extraction timeout**, max 1.5 MB JSON output from the extractor.
- Python subprocess does **not** receive command strings, user-controlled paths, or shell arguments other than an allowlisted extension. It reads file bytes from stdin, does not fetch URLs, and does not write uploaded files to disk.
- Malformed, empty, image-only, encrypted or unreadable documents fail with a visible error. Pages/slides with missing selectable text appear as **warnings** in the dry-run preview.
- There is **no OCR**. Scanned PDFs, images of code, and diagrams may lose content even if extraction finishes; verify the material before activating it.
- **No automatic question generation or textbook-quality evaluation** is performed. Retrieval and answer accuracy still require test questions and source comparison.
- All document contents are ultimately embedded using the configured provider, which **may send text to OpenAI**. Institutions should approve that use of their content. The document extraction stage itself is local.

## Tests

\`\`\`bash
cd backend
python3 -m unittest discover -s scripts -p test_extract_document.py -v
npm run typecheck

cd ../frontend
npm run typecheck
\`\`\`

The Python suite covers PDF text/page source, blank PDF rejection, DOCX tables, PPTX slide source, TXT, HTML sanitization, unicode, invalid ZIP, archive-entry limit and oversized files.

GitHub Actions workflow: \`.github/workflows/multi-format-ingestion.yml\`. It performs Python extraction tests and backend/frontend TypeScript checks. These checks are **not** proof of live Neon migration, OpenAI/Voyage API connectivity, or real browser end-to-end upload. Test on a **local throwaway Postgres** before any production deployment.

## Design references

- LangChain RecursiveCharacterTextSplitter: https://js.langchain.com/docs/how_to/recursive_text_splitter/
- pypdf text extraction caveats: https://pypdf.readthedocs.io/en/stable/user/extract-text.html
- python-docx: https://python-docx.readthedocs.io/en/latest/
- python-pptx: https://python-pptx.readthedocs.io/en/latest/
- Beautiful Soup: https://www.crummy.com/software/BeautifulSoup/bs4/doc/
