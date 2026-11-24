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

MAX_VISUAL_PAGES = 50
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


def persist_canonical_pdf(pdf_bytes, canonical_pdf_path):
    if not canonical_pdf_path:
        return None
    canonical = Path(canonical_pdf_path)
    if canonical.name != "canonical.pdf" or not canonical.parent.is_dir():
        raise ValueError("Invalid canonical PDF artifact path")
    canonical.write_bytes(pdf_bytes)
    return canonical


def _restore_office_address_space():
    """Let LibreOffice use the inherited hard limit, not Python's 1 GiB soft cap."""
    import resource
    _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    resource.setrlimit(resource.RLIMIT_AS, (hard, hard))


def office_to_pdf(data, extension, canonical_pdf_path=None):
    import resource
    _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    one_gib = 1024 * 1024 * 1024
    if hard != resource.RLIM_INFINITY and hard <= one_gib:
        raise ValueError("PowerPoint rendering is blocked by an inherited RLIMIT_AS hard limit of 1 GiB or less; the LibreOffice worker needs a higher address-space limit")
    from extract_document import convert_legacy_ppt
    if extension == ".ppt":
        data = convert_legacy_ppt(data)
    from extract_document import zip_guard
    zip_guard(data, 64 * 1024 * 1024)
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise ValueError("Visual analysis of DOCX/PPTX requires LibreOffice on the backend")
    # LibreOffice installations with sandboxing (for example, snap packages)
    # may not be allowed to read sources from /tmp. Prefer a private temp folder
    # under the service user's home, then fall back to the system temp directory.
    try:
        office_temp = tempfile.TemporaryDirectory(prefix="askaitutor-vis-", dir=str(Path.home()))
    except OSError:
        office_temp = tempfile.TemporaryDirectory(prefix="askaitutor-vis-")
    with office_temp as root:
        source = Path(root) / ("upload.docx" if extension == ".docx" else "upload.pptx")
        source.write_bytes(data)
        dest = Path(root) / "pdf"
        dest.mkdir()
        export_filter = "impress_pdf_Export" if extension in (".pptx", ".ppt") else "writer_pdf_Export"
        cmd = [soffice, "-env:UserInstallation=" + (Path(root) / "profile").as_uri(),
               "--headless", "--convert-to", "pdf:" + export_filter, "--outdir", str(dest), str(source)]
        try:
            p = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=25, cwd=root,
                               env=os.environ.copy(),
                               preexec_fn=_restore_office_address_space)
        except subprocess.TimeoutExpired as exc:
            raise ValueError("PowerPoint rendering timed out; split this presentation") from exc
        result = dest / "upload.pdf"
        if not result.exists() or result.stat().st_size < 5 or result.stat().st_size > 64 * 1024 * 1024:
            output_lines = (p.stderr + b"\n" + p.stdout).decode("utf-8", "replace").splitlines()
            meaningful = next((line.strip() for line in reversed(output_lines)
                               if any(token in line.lower() for token in
                                      ("fatal", "signal", "error", "failed", "cannot", "denied", "not found"))), "")
            detail = meaningful[:180] if meaningful else "no usable PDF was produced"
            raise ValueError("Unable to render PowerPoint slides for visual grounding "
                             "(LibreOffice exit " + str(p.returncode) + ": " + detail + ")")
        pdf_bytes = result.read_bytes()
        if not pdf_bytes.startswith(b"%PDF-"):
            raise ValueError("Unable to render PowerPoint slides for visual grounding "
                             "(LibreOffice output is not a valid PDF; exit " + str(p.returncode) + ")")
        # Some LibreOffice builds can report a shutdown error after completing a
        # valid export. Trust a bounded, valid PDF output rather than the exit code.
        persist_canonical_pdf(pdf_bytes, canonical_pdf_path)
        return pdf_bytes


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
        flowchart = any(
            shape.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE
            and "FLOW_CHART" in str(getattr(shape, "auto_shape_type", ""))
            for shape in slide.shapes
        )
        if pictures or flowchart or structural >= 2:
            targets.append(idx)
    return targets


def identify_docx_pages(doc):
    # A Word document's text and tables are already extracted natively by
    # python-docx, so sending a text/table-only page to the vision model only
    # produces a redundant description that duplicates content already captured.
    # Send a rendered page to vision only when it carries a real embedded raster
    # image (a photo, chart or diagram saved as a picture) or has no selectable
    # text at all (a blank or scanned page). Table grid-lines are vector art, not
    # raster images, so native tables are correctly skipped. Every skipped page
    # is reported so the caller can surface it for optional manual review.
    selected, skipped = [], []
    for idx in range(len(doc)):
        page = doc[idx]
        has_image = bool(page.get_images(full=True))
        has_text = bool(page.get_text("text").strip())
        if has_image or not has_text:
            selected.append(idx)
        else:
            skipped.append(idx)
    return selected, skipped


def identify_pdf_pages(doc):
    selected = []
    for idx in range(len(doc)):
        page = doc[idx]
        images = page.get_images(full=True)
        drawings = page.get_drawings()
        text = page.get_text("text").strip()
        complex_vector = any(len(drawing.get("items", [])) >= 3 for drawing in drawings)
        if images or len(drawings) >= 3 or complex_vector or (not text and drawings):
            selected.append(idx)
    return selected


def visual_pages(data, extension, limit, canonical_pdf_path=None):
    if extension in (".pptx", ".ppt"):
        targets = slide_visual_indexes(data, extension)
        # Keep a canonical PDF even when structural inspection finds no visual
        # candidates; the caller may still need the same artifact downstream.
        pdf = office_to_pdf(data, extension, canonical_pdf_path)
        name = "Slide"
    elif extension == ".pdf":
        pdf = data
        persist_canonical_pdf(data, canonical_pdf_path)
        name = "Page"
    elif extension == ".docx":
        # Render every uploaded Word document so every rendered page can be
        # checked for visual content, even if package metadata looks text-only.
        pdf = office_to_pdf(data, extension, canonical_pdf_path)
        name = "Page"
    else:
        return {"pages": [], "skipped": []}
    if not pdf:
        return {"pages": [], "skipped": []}
    skipped_idx = []
    # Import PyMuPDF by its current package name. The legacy `fitz` shim can
    # print a deprecation warning before the JSON payload, breaking the Node
    # caller which expects stdout to contain only JSON.
    import pymupdf as fitz
    # The canonical artifact is the single source of truth when the caller
    # requested retention; open that file directly rather than a parallel
    # in-memory copy so preview and downstream consumers share the same PDF.
    doc = fitz.open(canonical_pdf_path) if canonical_pdf_path else fitz.open(stream=pdf, filetype="pdf")
    if doc.is_encrypted:
        raise ValueError("Password-protected PDFs are not supported")
    if len(doc) > MAX_PAGES:
        raise ValueError("Document has too many pages or slides")
    if extension == ".pdf":
        targets = identify_pdf_pages(doc)
    elif extension == ".docx":
        # A Word page whose content is native text/tables is already captured by
        # python-docx; only genuine embedded images (or blank/scanned pages) need
        # vision. Skipped pages are reported so the caller can flag them.
        targets, skipped_idx = identify_docx_pages(doc)
    if len(targets) > limit:
        raise ValueError(f"Document has {len(targets)} visually significant pages; limit is {limit}. Split it into smaller documents instead of silently skipping diagrams.")
    if any(i >= len(doc) for i in targets):
        raise ValueError("Rendered presentation page count does not match slide count")
    return {
        "pages": [{"locator": f"{name} {i + 1}", "image": to_jpeg(doc[i])} for i in targets],
        "skipped": [f"{name} {i + 1}" for i in skipped_idx],
    }


def main():
    try:
        import resource
        _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
        one_gib = 1024 * 1024 * 1024
        address_space_soft = one_gib if hard == resource.RLIM_INFINITY else min(one_gib, hard)
        # Keep the hard limit intact so the isolated LibreOffice subprocess can
        # raise its soft limit for PDF export; this Python worker remains capped.
        resource.setrlimit(resource.RLIMIT_AS, (address_space_soft, hard))
        resource.setrlimit(resource.RLIMIT_CPU, (60, 65))
    except (ImportError, OSError, ValueError):
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--extension", required=True, choices=[".pdf", ".pptx", ".ppt", ".docx"])
    parser.add_argument("--max-bytes", type=int, default=10 * 1024 * 1024)
    parser.add_argument("--max-visual-pages", type=int, default=MAX_VISUAL_PAGES)
    parser.add_argument("--canonical-pdf", help="Persist the exact PDF used for page rendering in the upload job directory")
    args = parser.parse_args()
    try:
        if not 1 <= args.max_bytes <= 25 * 1024 * 1024 or not 1 <= args.max_visual_pages <= 50:
            raise ValueError("Invalid visual processing limits")
        data = sys.stdin.buffer.read(args.max_bytes + 1)
        if len(data) > args.max_bytes or not data:
            raise ValueError("File exceeds the configured upload limit")
        print(json.dumps(visual_pages(data, args.extension, args.max_visual_pages, args.canonical_pdf)))
    except Exception as exc:
        print(json.dumps({"error": str(exc)[:250]}))
        sys.exit(2)


if __name__ == "__main__":
    main()
