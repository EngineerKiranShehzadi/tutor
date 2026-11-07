#!/usr/bin/env python3
"""Local, text-only document extractor for AskAITutor.

Input: file bytes on stdin, extension as --extension.
Output: one JSON object with ordered units and extraction warnings.
No network requests, code execution, OCR, rendering or file writes.
"""
import argparse
import io
import json
import re
import sys
import zipfile

MAX_BYTES = 10 * 1024 * 1024
MAX_ZIP_ENTRIES = 500
MAX_ZIP_EXPANDED = 20 * 1024 * 1024
MAX_UNITS = 500
MAX_TEXT_CHARS = 900_000


def clean(text):
    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", text)
    return text.strip()


def zip_guard(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ZIP_ENTRIES:
                raise ValueError("Office file contains too many archive entries")
            if sum(i.file_size for i in entries) > MAX_ZIP_EXPANDED:
                raise ValueError("Office file expands beyond the safe size limit")
            if any(i.file_size > MAX_BYTES for i in entries):
                raise ValueError("Office file contains an oversized entry")
            if any(i.flag_bits & 0x1 for i in entries):
                raise ValueError("Encrypted Office files are not supported")
    except zipfile.BadZipFile as exc:
        raise ValueError("This is not a valid DOCX or PPTX file") from exc


def pdf_units(data, warnings):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted:
        raise ValueError("Password-protected PDFs are not supported")
    if len(reader.pages) > MAX_UNITS:
        raise ValueError("PDF has too many pages; split it into smaller files")
    out = []
    for number, page in enumerate(reader.pages, 1):
        # pypdf warns that huge expanded page streams can exhaust memory.
        contents = page.get_contents()
        if contents is not None and len(contents.get_data()) > 3 * 1024 * 1024:
            raise ValueError(f"PDF page {number} is too complex to extract safely")
        text = clean(page.extract_text(extraction_mode="layout") or "")
        if text:
            out.append({"locator": f"Page {number}", "text": text})
        else:
            warnings.append(f"Page {number} has no selectable text (scanned/image-only pages need OCR)")
    return out


def docx_units(data, warnings):
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    zip_guard(data)
    document = Document(io.BytesIO(data))
    blocks = []
    for element in document.iter_inner_content():
        if isinstance(element, Paragraph):
            value = clean(element.text)
            if value:
                blocks.append(value)
        elif isinstance(element, Table):
            for row in element.rows:
                cells = [clean(cell.text) for cell in row.cells]
                if any(cells):
                    blocks.append(" | ".join(cells))
    return [{"locator": "Document", "text": "\n\n".join(blocks)}] if blocks else []


def pptx_units(data, warnings):
    from pptx import Presentation
    zip_guard(data)
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
                for row in shape.table.rows:
                    cells = [clean(cell.text) for cell in row.cells]
                    if any(cells):
                        blocks.append(" | ".join(cells))
        text = "\n\n".join(blocks)
        if text:
            output.append({"locator": f"Slide {number}", "text": text})
        else:
            warnings.append(f"Slide {number} has no selectable text (images/diagrams need OCR or captions)")
    return output


def html_units(data, warnings):
    from bs4 import BeautifulSoup
    html = data.decode("utf-8-sig")
    soup = BeautifulSoup(html, "html.parser")
    for item in soup(["script", "style", "noscript", "template", "svg", "iframe",
                       "nav", "footer", "aside"]):
        item.decompose()
    root = soup.find("main") or soup.find("article") or soup.body or soup
    # Keep table rows together so cell values do not lose their relationship.
    for tr in root.find_all("tr"):
        cells = [clean(cell.get_text(" ", strip=True)) for cell in tr.find_all(["th", "td"], recursive=False)]
        if cells:
            tr.replace_with(soup.new_string("\n" + " | ".join(cells) + "\n"))
    for element in root.find_all(["h1", "h2", "h3", "h4", "p", "li", "pre", "blockquote"]):
        element.insert_before(soup.new_string("\n"))
        element.insert_after(soup.new_string("\n"))
    text = clean(root.get_text(" ", strip=False))
    return [{"locator": "Document", "text": text}] if text else []


def extract(data, extension):
    warnings = []
    if not data or len(data) > MAX_BYTES:
        raise ValueError("File must be non-empty and no larger than 10 MB")
    ext = extension.lower()
    if ext == ".pdf":
        if not data.startswith(b"%PDF-"):
            raise ValueError("File content is not a PDF")
        units = pdf_units(data, warnings)
    elif ext == ".docx":
        units = docx_units(data, warnings)
    elif ext == ".pptx":
        units = pptx_units(data, warnings)
    elif ext in {".html", ".htm"}:
        units = html_units(data, warnings)
    elif ext == ".txt":
        units = [{"locator": "Document", "text": clean(data.decode("utf-8-sig"))}]
    else:
        raise ValueError("Unsupported document type")
    units = [unit for unit in units if unit["text"]]
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
    args = parser.parse_args()
    try:
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
        print(json.dumps(extract(data, args.extension), ensure_ascii=False))
    except Exception as exc:
        # Return a controlled, bounded message; never echo file content or tracebacks.
        print(json.dumps({"error": str(exc)[:250]}, ensure_ascii=False))
        sys.exit(2)


if __name__ == "__main__":
    main()
