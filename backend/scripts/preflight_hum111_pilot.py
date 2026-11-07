#!/usr/bin/env python3
"""HUM111 Lectures 1-2: official CCW lesson/video/PDF pairing and PDF extraction preflight.

Read-only against AskAITutor / Neon. Never performs uploads, embeddings, or database writes.
Usage (backend Python venv): python scripts/preflight_hum111_pilot.py --save-pdfs
"""
import argparse
import json
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlparse
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup
from extract_document import extract

HOST = "ccw.vcomsats.edu.pk"
LESSONS = {
    1: ("NDIwNg==", "Ideology of Pakistan"),
    2: ("NDIwNw==", "Nationalism and Two Nation Theory"),
}
MAX_PDF_BYTES = 10 * 1024 * 1024


def read(url, limit, timeout):
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 AskAITutor Academic Preflight"})
    with urlopen(req, timeout=timeout) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Downloaded resource exceeds the file limit")
    return data


def norm(text):
    return re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()


def video_id(url):
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if host in ("youtube.com", "www.youtube.com", "m.youtube.com"):
        value = (parse_qs(u.query).get("v") or [None])[0]
    elif host in ("youtu.be", "www.youtu.be"):
        value = u.path.strip("/").split("/")[0]
    else:
        return None
    return value if value and re.fullmatch(r"[A-Za-z0-9_-]{11}", value) else None


def inspect_lesson(html, url, expected_title):
    soup = BeautifulSoup(html, "html.parser")
    headings = [tag.get_text(" ", strip=True) for tag in soup.find_all(["h1", "h2", "h3", "h4", "h5"])]
    numbers = [int(m.group(1)) for txt in headings
               if (m := re.search(r"Lecture\s+(\d+)\s*/\s*of\s+HUM111", txt, re.I))]
    title_ok = any(norm(t) == norm(expected_title) for t in headings)
    pdf_url = video_url = None
    for tag in soup.find_all("a", href=True):
        label = norm(tag.get_text(" ", strip=True))
        link = urljoin(url, tag["href"])
        u = urlparse(link)
        if "youtube link" in label and video_id(link):
            video_url = link
        if "handouts notes" in label and u.hostname == HOST and u.path.lower().endswith(".pdf"):
            pdf_url = link
    return numbers[0] if numbers else None, title_ok, video_url, pdf_url


def inspect_video_title(url, timeout):
    # Best-effort; YouTube's public oEmbed may be unavailable. This does NOT
    # validate the full recorded lesson, only public video metadata.
    endpoint = "https://www.youtube.com/oembed?" + urlencode({"url": url, "format": "json"})
    try:
        data = json.loads(read(endpoint, 100_000, timeout))
        return data.get("title"), None
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as exc:
        return None, type(exc).__name__


def audit(number, expected, lesson_code, outdir, timeout, save_pdfs):
    lesson_url = "https://" + HOST + "/Home/Lesson?" + urlencode({"LID": lesson_code})
    row = {"lecture": number, "title": expected, "lesson_url": lesson_url,
           "pdf_url": None, "youtube_url": None, "youtube_id": None,
           "youtube_title": None, "youtube_title_status": "unchecked",
           "pdf_pages_with_text": None, "pdf_characters": None,
           "pdf_warnings": [], "status": "NEEDS_REVIEW", "problems": []}
    try:
        html = read(lesson_url, 2_000_000, timeout).decode("utf-8", "replace")
        found_num, title_ok, vlink, plink = inspect_lesson(html, lesson_url, expected)
        row["pdf_url"], row["youtube_url"] = plink, vlink
        row["youtube_id"] = video_id(vlink) if vlink else None
        if found_num != number:
            row["problems"].append("Official lesson number mismatch")
        if not title_ok:
            row["problems"].append("Official lesson heading differs from expected title")
        if not vlink:
            row["problems"].append("No YouTube URL linked in official lesson")
        if not plink:
            row["problems"].append("No PDF linked in official lesson")
        if vlink:
            ytitle, error = inspect_video_title(vlink, timeout)
            row["youtube_title"] = ytitle
            row["youtube_title_status"] = error or "available"
            if ytitle:
                match = re.search(r"\b(?:lecture|lec)\s*0*(\d+)\b", ytitle, re.I)
                if match and int(match.group(1)) != number:
                    row["problems"].append("YouTube metadata identifies a different lecture number")
        if plink:
            data = read(plink, MAX_PDF_BYTES, timeout)
            if not data.startswith(b"%PDF-"):
                raise ValueError("Linked resource is not a PDF")
            report = extract(data, ".pdf")
            units = report["units"]
            first = units[0]["text"] if units else ""
            row["pdf_pages_with_text"] = len(units)
            row["pdf_characters"] = sum(len(unit["text"]) for unit in units)
            row["pdf_warnings"] = report["warnings"]
            if not re.search(rf"Lecture\s+0*{number}\b", first, re.I):
                row["problems"].append("Number inside PDF does not match")
            if norm(expected) not in norm(first):
                row["problems"].append("Topic title inside PDF does not match")
            if save_pdfs and not row["problems"]:
                outdir.mkdir(parents=True, exist_ok=True)
                filename = outdir / f"HUM111_Lecture{number:02d}.pdf"
                filename.write_bytes(data)
                row["downloaded_pdf"] = str(filename.resolve())
        if not row["problems"] and vlink and plink:
            row["status"] = "OFFICIAL_PORTAL_PAIRED_VIDEO_CONTENT_UNVERIFIED"
    except (HTTPError, URLError, TimeoutError, ValueError, OSError) as exc:
        row["problems"].append(f"{type(exc).__name__}: {str(exc)[:180]}")
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path.home() / "hum111-pilot")
    parser.add_argument("--timeout", type=int, default=25)
    parser.add_argument("--save-pdfs", action="store_true",
                        help="Save PDFs for authorized local noncommercial academic testing")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    rows = [audit(n, title, code, args.out, args.timeout, args.save_pdfs)
            for n, (code, title) in LESSONS.items()]
    destination = args.out / "preflight.json"
    destination.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    for row in rows:
        print(f"Lecture {row['lecture']:02d}: {row['status']}, PDF pages={row['pdf_pages_with_text']}")
        for message in row["problems"]:
            print("  ISSUE:", message)
        if not row["youtube_title"]:
            print("  NOTE: YouTube title/audio could not be verified.")
    print("Report:", destination)
    print("No database writes, embeddings or LLM API calls were made.")
    if any(row["problems"] for row in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
