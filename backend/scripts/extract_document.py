#!/usr/bin/env python3
"""Local document text extractor for AskAITutor.

Input: file bytes on stdin, extension as --extension.
Output: one JSON object with ordered units and extraction warnings.
No network requests, macros, OCR or rendering. Temporary files are used only for local legacy-PPT conversion.
"""
import argparse
import io
import json
import re
import sys
import zipfile
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

MAX_BYTES = 10 * 1024 * 1024
MAX_ZIP_ENTRIES = 500
MAX_ZIP_EXPANDED = 64 * 1024 * 1024
MAX_UNITS = 500
MAX_TEXT_CHARS = 900_000


def clean(text):
    text = text.replace("\x00", "").replace("\x0b", "\n").replace("\r\n", "\n").replace("\r", "\n")
    # Remove known private-use citation/navigation glyphs that can leak into
    # copied Word text from rich web/LLM responses. They are not lecture text
    # and otherwise pollute embeddings and student answers.
    text = re.sub("\ue200navlist\ue202[^\\n]*", "", text, flags=re.I)
    # Remove citation token artifacts and all observed private-use navigation/citation markers.
    text = re.sub(r"citeturn\d+search\d+", "", text, flags=re.I)
    text = text.translate(str.maketrans("", "", "\ue200\ue201\ue202\ue203\ue204\ue206"))
    # Remove copied ChatGPT response chrome but keep reference titles.
    text = re.sub(r"(?im)^\s*Is this conversation helpful so far\?\s*$", "", text)
    text = re.sub(r"(?m)^\s*4o\s*$", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", text)
    return text.strip()


def zip_guard(data, max_bytes=MAX_BYTES):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ZIP_ENTRIES:
                raise ValueError("Office file contains too many archive entries")
            if sum(i.file_size for i in entries) > MAX_ZIP_EXPANDED:
                raise ValueError("Office file expands beyond the safe size limit")
            if any(i.file_size > max_bytes for i in entries):
                raise ValueError("Office file contains an oversized entry")
            if any(i.flag_bits & 0x1 for i in entries):
                raise ValueError("Encrypted Office files are not supported")
    except zipfile.BadZipFile as exc:
        raise ValueError("This is not a valid DOCX or PPTX file") from exc


def pdf_units(data, warnings, include_empty=False):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted:
        raise ValueError("Password-protected PDFs are not supported")
    if len(reader.pages) > MAX_UNITS:
        raise ValueError("PDF has too many pages; split it into smaller files")
    pages = []
    for number, page in enumerate(reader.pages, 1):
        # pypdf warns that huge expanded page streams can exhaust memory.
        contents = page.get_contents()
        if contents is not None and len(contents.get_data()) > 3 * 1024 * 1024:
            raise ValueError(f"PDF page {number} is too complex to extract safely")
        text = clean(page.extract_text(extraction_mode="layout") or "")
        pages.append((number, text))

    # Strip exact lines repeated at the top or bottom of multiple pages. This
    # removes running course headers/footer chrome without touching repeated
    # body text in the middle of a page.
    chrome_counts = {}
    for _, text in pages:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        for line in set(lines[:3] + lines[-3:]):
            normalized = re.sub(r"\s+", " ", line).strip().casefold()
            if len(normalized) > 3:
                chrome_counts[normalized] = chrome_counts.get(normalized, 0) + 1
    repeated_chrome = {line for line, count in chrome_counts.items() if count >= 2}
    out = []
    for number, text in pages:
        kept = []
        for line in text.splitlines():
            normalized = re.sub(r"\s+", " ", line).strip().casefold()
            if re.fullmatch(r"page\s+\d+\s+of\s+\d+", normalized):
                continue
            if line.strip() and normalized in repeated_chrome:
                continue
            kept.append(line)
        text = clean("\n".join(kept))
        if text:
            out.append({"locator": f"Page {number}", "text": text})
        else:
            warnings.append(f"Page {number} has no selectable text (visual analysis needed)")
            if include_empty:
                out.append({"locator": f"Page {number}", "text": ""})
    return out


def docx_units(data, warnings):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    zip_guard(data)
    document = Document(io.BytesIO(data))
    sections = []
    current = []
    locator = "Document"
    heading_count = 0
    inside_slides = False
    slide_number = 0
    slide_heading = re.compile(r"^(?:slide|page)\s*(?:no\.?|number|#)?\s*[:.\-]?\s*(\d+)\b", re.I)

    def flush():
        nonlocal current
        if current:
            sections.append({"locator": locator, "text": "\n\n".join(current)})
            current = []

    elements = list(document.iter_inner_content())
    pending_slide_headings = []
    duplicate_heading_to_skip = None

    for element_index, element in enumerate(elements):
        if isinstance(element, Paragraph):
            value = clean(element.text)
            if not value:
                continue
            slide = slide_heading.match(value)
            standalone_slide = value.strip().upper() == "SLIDE"
            style = (element.style.name or "").lower() if element.style else ""
            structured_heading = style.startswith("heading ") or style == "title"
            if duplicate_heading_to_skip is not None:
                is_duplicate = value.casefold() == duplicate_heading_to_skip.casefold()
                duplicate_heading_to_skip = None
                if is_duplicate:
                    continue
            if standalone_slide or slide or (structured_heading and not inside_slides):
                flush()
                if standalone_slide or slide:
                    inside_slides = True
                    slide_number = int(slide.group(1)) if slide else slide_number + 1
                    locator = "Slide " + str(slide_number)
                    if pending_slide_headings:
                        current.extend(pending_slide_headings)
                        duplicate_heading_to_skip = pending_slide_headings[-1]
                        pending_slide_headings = []
                else:
                    heading_count += 1
                    locator = "Section " + str(heading_count) + ": " + value[:75]
                # Retain the heading itself as searchable evidence.
                if not standalone_slide:
                    current.append(value)
            else:
                current.append(value)
        elif isinstance(element, Table):
            # Recognize real Question/Answer tables rather than splitting a
            # question column from the corresponding answer column.
            table_rows = [[clean(cell.text) for cell in row.cells] for row in element.rows]
            # Some Word-exported slide decks place a one-cell title table just
            # before the next standalone SLIDE marker. Keep that title with the
            # next slide instead of contaminating the previous slide's chunk.
            next_content = next((candidate for candidate in elements[element_index + 1:]
                                 if not isinstance(candidate, Paragraph) or clean(candidate.text)), None)
            is_next_slide_title = (
                len(table_rows) == 1 and len(table_rows[0]) == 1
                and 0 < len(table_rows[0][0]) <= 140
                and isinstance(next_content, Paragraph)
                and clean(next_content.text).upper() == "SLIDE"
            )
            if is_next_slide_title:
                pending_slide_headings.append(table_rows[0][0])
                continue
            header = [v.lower().rstrip(":") for v in table_rows[0]] if table_rows else []
            qa_table = len(header) >= 2 and header[0] in {"question", "questions", "q"} and header[1] in {"answer", "answers", "a"}
            for index, cells in enumerate(table_rows):
                if not any(cells):
                    continue
                if qa_table and index == 0:
                    continue
                if len(cells) >= 2 and qa_table:
                    current.append("Question: " + cells[0] + "\nAnswer: " + cells[1])
                else:
                    current.append(" | ".join(cells))
    flush()
    # A stray preamble fragment such as the observed "tea" extraction artifact
    # is not a meaningful section. Drop only a tiny unstructured first unit
    # when a real slide/heading follows; preserve short titles otherwise.
    if len(sections) > 1 and sections[0]["locator"] == "Document":
        preamble = sections[0]["text"].strip()
        if len(preamble) < 25 and len(preamble.split()) < 5:
            sections.pop(0)
            warnings.append("Ignored a short, unstructured DOCX preamble before the first heading or slide.")
    if sections and sections[0]["locator"] == "Document":
        warnings.append("Text before the first slide marker was found; review this document preamble.")
    if len(sections) > MAX_UNITS:
        raise ValueError("Word document has too many logical sections")
    return sections


def pptx_units(data, warnings, include_empty=False, max_bytes=MAX_BYTES):
    from pptx import Presentation
    zip_guard(data, max_bytes)
    presentation = Presentation(io.BytesIO(data))
    if len(presentation.slides) > MAX_UNITS:
        raise ValueError("Presentation has too many slides; split it into smaller files")
    output = []
    for number, slide in enumerate(presentation.slides, 1):
        blocks = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                value = clean(shape.text)
                if value:
                    blocks.append(value)
            if shape.has_table:
                table_rows = [[clean(cell.text) for cell in row.cells] for row in shape.table.rows]
                headers = [v.lower().rstrip(":") for v in table_rows[0]] if table_rows else []
                qa_table = len(headers) >= 2 and headers[0] in {"question", "questions", "q"} and headers[1] in {"answer", "answers", "a"}
                for index, cells in enumerate(table_rows):
                    if not any(cells) or (qa_table and index == 0):
                        continue
                    if len(cells) >= 2 and qa_table:
                        blocks.append("Question: " + cells[0] + "\nAnswer: " + cells[1])
                    else:
                        blocks.append(" | ".join(cells))
        text = "\n\n".join(blocks)
        # Office can append a standalone slide number after the extracted
        # content. Remove only numeric-only trailing lines.
        text = re.sub(r"(?:\n\s*\d{1,4}\s*)+$", "", text).strip()
        if text:
            output.append({"locator": f"Slide {number}", "text": text})
        else:
            warnings.append(f"Slide {number} has no selectable text (visual analysis needed)")
            if include_empty:
                output.append({"locator": f"Slide {number}", "text": ""})
    return output


def convert_legacy_ppt(data):
    """Convert OLE PPT to PPTX with a private headless LibreOffice profile."""
    if not data.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
        raise ValueError("File content is not a legacy PowerPoint (.ppt)")
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise ValueError("Legacy .ppt requires LibreOffice (soffice) on the backend server")
    with tempfile.TemporaryDirectory(prefix="askaitutor-ppt-") as tmp:
        root = Path(tmp)
        src = root / "uploaded.ppt"
        src.write_bytes(data)
        output_dir = root / "converted"
        output_dir.mkdir()
        profile = (root / "lo-profile").as_uri()
        try:
            proc = subprocess.run(
                [soffice, "-env:UserInstallation=" + profile, "--headless",
                 "--convert-to", "pptx", "--outdir", str(output_dir), str(src)],
                cwd=tmp, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=25, check=False,
                env={**os.environ, "HOME": tmp},
            )
        except subprocess.TimeoutExpired as exc:
            raise ValueError("Legacy .ppt conversion timed out; split the presentation") from exc
        converted = output_dir / "uploaded.pptx"
        if proc.returncode != 0 or not converted.exists():
            raise ValueError("Unable to convert legacy .ppt; verify that the presentation is not corrupt")
        result = converted.read_bytes()
        if not result or len(result) > MAX_ZIP_EXPANDED:
            raise ValueError("Converted presentation exceeds the safe size limit")
        return result


def html_units(data, warnings):
    from bs4 import BeautifulSoup
    html = data.decode("utf-8-sig")
    soup = BeautifulSoup(html, "html.parser")
    for item in soup(["script", "style", "noscript", "template", "svg", "iframe",
                       "nav", "footer", "aside"]):
        item.decompose()
    root = soup.find("main") or soup.find("article") or soup.body or soup
    # Emit heading-scoped units in source order. Lists remain one block per
    # item and table rows retain their cell relationships.
    units, blocks = [], []
    heading, section_number = None, 0

    def flush():
        nonlocal blocks, section_number
        body = clean("\n".join(blocks))
        # A heading alone is locator metadata; don't create a heading-only
        # record if the following section contains the actual content.
        if body and body.strip().casefold() != str(heading or "").strip().casefold():
            section_number += 1
            locator = f"Section {section_number}: {heading[:75]}" if heading else f"Section {section_number}"
            units.append({"locator": locator, "text": body})
        blocks = []

    def walk(node):
        nonlocal heading
        for child in getattr(node, "children", []):
            name = getattr(child, "name", None)
            if not name:
                value = clean(str(child))
                if value:
                    blocks.append(value)
                continue
            name = name.lower()
            if name in {"h1", "h2", "h3", "h4"}:
                flush()
                heading = clean(child.get_text(" ", strip=True))[:150] or heading
                blocks.append(heading)
            elif name in {"p", "li", "pre", "blockquote"}:
                value = clean(child.get_text(" ", strip=True))
                if value:
                    blocks.append(value)
            elif name == "table":
                for tr in child.find_all("tr"):
                    cells = [clean(cell.get_text(" ", strip=True)) for cell in tr.find_all(["th", "td"], recursive=False)]
                    if any(cells):
                        blocks.append(" | ".join(cells))
            elif name in {"section", "article"}:
                if blocks:
                    flush()
                walk(child)
                if blocks:
                    flush()
            else:
                walk(child)

    walk(root)
    if blocks:
        flush()
    return units


def txt_units(data):
    text = clean(data.decode("utf-8-sig"))
    if not text:
        return []
    lines = text.splitlines()
    units, current = [], []
    heading, section_number = None, 0
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        underline = i + 1 < len(lines) and re.fullmatch(r"\s*(?:=+|-{3,})\s*", lines[i + 1])
        markdown_heading = re.match(r"^#{1,4}\s+(.+)$", line)
        if markdown_heading or underline:
            if current:
                section_number += 1
                locator = f"Section {section_number}: {heading[:75]}" if heading else f"Section {section_number}"
                units.append({"locator": locator, "text": clean("\n".join(current))})
                current = []
            heading = (markdown_heading.group(1) if markdown_heading else line).strip()
            current.append(heading)
            i += 2 if underline else 1
            continue
        current.append(line)
        i += 1
    if current:
        section_number += 1
        locator = f"Section {section_number}: {heading[:75]}" if heading else f"Section {section_number}"
        units.append({"locator": locator, "text": clean("\n".join(current))})
    return units


def extract(data, extension, include_empty=False, max_bytes=MAX_BYTES):
    warnings = []
    if not data or len(data) > max_bytes:
        raise ValueError(f"File must be non-empty and no larger than {max_bytes // (1024 * 1024)} MB")
    ext = extension.lower()
    if ext == ".pdf":
        if not data.startswith(b"%PDF-"):
            raise ValueError("File content is not a PDF")
        units = pdf_units(data, warnings, include_empty)
    elif ext == ".docx":
        units = docx_units(data, warnings)
    elif ext == ".pptx":
        units = pptx_units(data, warnings, include_empty, max_bytes)
    elif ext == ".ppt":
        units = pptx_units(convert_legacy_ppt(data), warnings, include_empty, MAX_ZIP_EXPANDED)
    elif ext in {".html", ".htm"}:
        units = html_units(data, warnings)
    elif ext == ".txt":
        units = txt_units(data)
    else:
        raise ValueError("Unsupported document type")
    units = [unit for unit in units if unit["text"] or (include_empty and ext in {".pdf", ".pptx", ".ppt"})]
    if not units:
        raise ValueError("No selectable text was found; scanned documents need OCR")
    if sum(len(unit["text"]) for unit in units) > MAX_TEXT_CHARS:
        raise ValueError("Extracted text is too large; upload smaller documents")
    return {"units": units, "warnings": warnings}


def main():
    # Bound CPU and virtual memory on Unix/Linux hosts. Node also enforces a
    # wall-clock timeout, so malformed inputs cannot block API workers forever.
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (20, 22))
    except (ImportError, OSError, ValueError):
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--extension", required=True)
    parser.add_argument("--allow-visual", action="store_true")
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    args = parser.parse_args()
    if not 1 <= args.max_bytes <= 25 * 1024 * 1024:
        print(json.dumps({"error": "Document upload cap must be between 1 byte and 25 MB"}))
        sys.exit(2)
    try:
        data = sys.stdin.buffer.read(args.max_bytes + 1)
        print(json.dumps(extract(data, args.extension, args.allow_visual, args.max_bytes), ensure_ascii=False))
    except Exception as exc:
        # Return a controlled, bounded message; never echo file content or tracebacks.
        print(json.dumps({"error": str(exc)[:250]}, ensure_ascii=False))
        sys.exit(2)


if __name__ == "__main__":
    main()
