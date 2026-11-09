#!/usr/bin/env python3
"""Bounded local visual-page detection/rendering for the existing RAG ingestion.
The model receives whole-page/slide context, not detached images.
"""
import argparse
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_VISUAL_PAGES = 30
MAX_PAGES = 500
MAX_RENDER_PIXELS = 1300 * 1300


def to_jpeg(page):
    import pymupdf as fitz
    from PIL import Image
    ratio = min(1.6, 1300 / max(page.rect.width, page.rect.height, 1))
    pix = page.get_pixmap(matrix=fitz.Matrix(ratio, ratio), alpha=False)
    if pix.width * pix.height > MAX_RENDER_PIXELS:
        raise ValueError("Rendered page exceeds safe pixel limit")
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=72, optimize=True)
    if out.tell() > 350_000:
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=52, optimize=True)
    if out.tell() > 350_000:
        raise ValueError("Rendered page is too complex for bounded visual analysis")
    return base64.b64encode(out.getvalue()).decode("ascii")


def office_to_pdf(data, extension):
    from extract_document import convert_legacy_ppt
    if extension == ".ppt":
        data = convert_legacy_ppt(data)
    from extract_document import zip_guard
    zip_guard(data, 64 * 1024 * 1024)
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise ValueError("Visual analysis of PowerPoint requires LibreOffice on the backend")
    with tempfile.TemporaryDirectory(prefix="askaitutor-vis-") as root:
        source = Path(root) / "upload.pptx"
        source.write_bytes(data)
        dest = Path(root) / "pdf"
        dest.mkdir()
        cmd = [soffice, "-env:UserInstallation=" + (Path(root) / "profile").as_uri(),
               "--headless", "--convert-to", "pdf", "--outdir", str(dest), str(source)]
        try:
            p = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=25, cwd=root,
                               env={**os.environ, "HOME": root})
        except subprocess.TimeoutExpired as exc:
            raise ValueError("PowerPoint rendering timed out; split this presentation") from exc
        result = dest / "upload.pdf"
        if p.returncode or not result.exists() or result.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("Unable to render PowerPoint slides for visual grounding")
        return result.read_bytes()


def slide_visual_indexes(data, extension):
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    from extract_document import convert_legacy_ppt, zip_guard
    if extension == ".ppt":
        data = convert_legacy_ppt(data)
    zip_guard(data, 64 * 1024 * 1024)
    prs = Presentation(io.BytesIO(data))
    targets = []
    types = {MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.CHART, MSO_SHAPE_TYPE.GROUP,
             MSO_SHAPE_TYPE.FREEFORM, MSO_SHAPE_TYPE.AUTO_SHAPE,
             MSO_SHAPE_TYPE.LINE, MSO_SHAPE_TYPE.TABLE, MSO_SHAPE_TYPE.DIAGRAM,
             MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT}
    for idx, slide in enumerate(prs.slides):
        structural = sum(1 for shape in slide.shapes if shape.shape_type in types)
        pictures = any(shape.shape_type in (MSO_SHAPE_TYPE.PICTURE, MSO_SHAPE_TYPE.GROUP,
                                            MSO_SHAPE_TYPE.TABLE, MSO_SHAPE_TYPE.CHART, MSO_SHAPE_TYPE.DIAGRAM) for shape in slide.shapes)
        if pictures or structural >= 2:
            targets.append(idx)
    return targets


def identify_pdf_pages(doc):
    selected = []
    for idx in range(len(doc)):
        page = doc[idx]
        images = page.get_images(full=True)
        drawings = page.get_drawings()
        text = page.get_text("text").strip()
        if images or len(drawings) >= 3 or (not text and drawings):
            selected.append(idx)
    return selected


def visual_pages(data, extension, limit):
    import fitz
    if extension in (".pptx", ".ppt"):
        targets = slide_visual_indexes(data, extension)
        pdf = office_to_pdf(data, extension) if targets else b""
        name = "Slide"
    elif extension == ".pdf":
        pdf = data
        name = "Page"
    else:
        return []
    if not pdf:
        return []
    doc = fitz.open(stream=pdf, filetype="pdf")
    if doc.is_encrypted:
        raise ValueError("Password-protected PDFs are not supported")
    if len(doc) > MAX_PAGES:
        raise ValueError("Document has too many pages or slides")
    if extension == ".pdf":
        targets = identify_pdf_pages(doc)
    if len(targets) > limit:
        raise ValueError(f"Document has {len(targets)} visually significant pages; limit is {limit}. Split it into smaller documents instead of silently skipping diagrams.")
    if any(i >= len(doc) for i in targets):
        raise ValueError("Rendered presentation page count does not match slide count")
    return [{"locator": f"{name} {i + 1}", "image": to_jpeg(doc[i])} for i in targets]


def main():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (60, 65))
    except (ImportError, OSError, ValueError):
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--extension", required=True, choices=[".pdf", ".pptx", ".ppt"])
    parser.add_argument("--max-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--max-visual-pages", type=int, default=MAX_VISUAL_PAGES)
    args = parser.parse_args()
    try:
        if not 1 <= args.max_bytes <= 25 * 1024 * 1024 or not 1 <= args.max_visual_pages <= 50:
            raise ValueError("Invalid visual processing limits")
        data = sys.stdin.buffer.read(args.max_bytes + 1)
        if len(data) > args.max_bytes or not data:
            raise ValueError("File exceeds the configured upload limit")
        print(json.dumps({"pages": visual_pages(data, args.extension, args.max_visual_pages)}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)[:250]}))
        sys.exit(2)


if __name__ == "__main__":
    main()
