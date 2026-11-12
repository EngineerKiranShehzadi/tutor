#!/usr/bin/env python3
"""Experimental captions-only pilot. No audio/video downloads, cookies or bypasses."""
import json
import re
import sys

try:
    video_id = sys.argv[1]
    if len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("Invalid video ID")
    from youtube_transcript_api import YouTubeTranscriptApi
    fetched = YouTubeTranscriptApi().fetch(video_id, languages=["hi", "en"])
    cues = []
    for item in fetched:
        text = str(item.text).strip()
        if not text:
            continue
        start = max(0, round(float(item.start) * 1000))
        end = max(start + 1, round((float(item.start) + float(item.duration)) * 1000))
        cues.append({"startMs": start, "endMs": end, "text": text})
        if len(cues) > 20000:
            raise ValueError("Too many caption cues")
    if not cues:
        raise ValueError("Empty captions")
    print(json.dumps({"language": getattr(fetched, "language_code", "unknown"), "cues": cues}, ensure_ascii=False))
except Exception:
    print(json.dumps({"error": "CAPTIONS_UNAVAILABLE"}))
    sys.exit(2)
