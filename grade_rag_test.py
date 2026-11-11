#!/usr/bin/env python3
"""Fill Match_Status in the RAG test results by comparing each System_Answer
with the Verified_Answer, using an OpenAI model as the judge.

Run it after run_rag_test.py has finished (both write the same results file).

- Writes Match_Status (the sheet's dropdown values) and a one-line reason in
  Notes, prefixed "AUTO:" so automatic grades are easy to tell apart.
- Rows that already have a Match_Status are skipped, so a manual grade is never
  overwritten and a rerun only grades what is left. --regrade grades them again
  (rows whose Notes aren't "AUTO:" are still left alone).
- Rows without a System_Answer are skipped.
- The OpenAI key is read from backend/.env (or the OPENAI_API_KEY env var).

Usage:
  .venv/bin/python grade_rag_test.py               # grade the results file
  .venv/bin/python grade_rag_test.py --limit 10    # quick check
"""
import argparse
import collections
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import openpyxl
import requests

SHEET = "Test_Sheet"
COL_LECTURE, COL_ID, COL_QUESTION, COL_VERIFIED = 1, 2, 3, 4
COL_SYSTEM_ANSWER, COL_MATCH, COL_NOTES = 7, 8, 9
STATUSES = ["Correct", "Partial", "Wrong", "Hallucinated", "Not_Found"]

SYSTEM_PROMPT = """You grade answers from a lecture Q&A tutor against a teacher-verified reference answer.

Pick exactly one status. Check them in this order and take the first that fits:
1. Not_Found: the tutor gave no real answer. It says the information is not in the lecture, it doesn't know, asks the student to rephrase, or refuses.
2. Hallucinated: the tutor confidently states specific details (names, numbers, dates, titles, steps, examples, quotes) that contradict the reference, i.e. invented facts presented as lecture content.
3. Wrong: the tutor answers, but the main point is incorrect or it answers a different question, without invented specifics as in 2.
4. Partial: the main point is right, but an essential part of the reference is missing, or a minor detail is incorrect.
5. Correct: every essential fact of the reference is there, in any wording.

Rules:
- Judge meaning, not wording or formatting. Markdown is fine.
- The reference often says where the information appears (a slide, a timestamp, "Sir says ..."). That is provenance, not required content.
- Extra details in the tutor's answer are fine unless they contradict the reference.
- reason: one short plain sentence (at most 25 words) saying what is missing or wrong, or "Matches the reference." when Correct."""

SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": STATUSES},
        "reason": {"type": "string"},
    },
    "required": ["status", "reason"],
    "additionalProperties": False,
}


class StopRun(Exception):
    """An error that retrying won't fix (bad key, no quota)."""


def read_key(here):
    if os.environ.get("OPENAI_API_KEY"):
        return os.environ["OPENAI_API_KEY"]
    env = os.path.join(here, "backend", ".env")
    if os.path.exists(env):
        for line in open(env):
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("OPENAI_API_KEY not found in the environment or backend/.env")


def judge(key, base, model, effort, question, verified, answer, retries=5):
    body = {
        "model": model,
        "reasoning_effort": effort,
        "max_completion_tokens": 2000,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Question:\n{question}\n\nReference answer:\n{verified}\n\nTutor's answer:\n{answer}"},
        ],
        "response_format": {"type": "json_schema", "json_schema": {"name": "grade", "strict": True, "schema": SCHEMA}},
    }
    last = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.post(f"{base}/chat/completions", json=body, timeout=120,
                              headers={"Authorization": f"Bearer {key}"})
        except requests.RequestException as e:
            last = str(e)
        else:
            if r.status_code == 200:
                out = json.loads(r.json()["choices"][0]["message"]["content"])
                if out.get("status") in STATUSES:
                    return out["status"], out.get("reason", "").strip()
                last = f"unexpected status {out.get('status')!r}"
            else:
                err = (r.json().get("error") or {}) if r.content else {}
                last = f"{r.status_code} {err.get('code') or ''} {err.get('message') or r.text[:200]}".strip()
                if r.status_code in (401, 403) or err.get("code") == "insufficient_quota":
                    raise StopRun(last)
                if r.status_code < 500 and r.status_code != 429:
                    raise RuntimeError(last)
        time.sleep(min(60, 3 * 2 ** (attempt - 1)))
    raise RuntimeError(last)


def save(wb, path):
    fd, tmp = tempfile.mkstemp(suffix=".xlsx", dir=os.path.dirname(os.path.abspath(path)))
    os.close(fd)
    wb.save(tmp)
    os.replace(tmp, path)


def answering_in_progress():
    try:
        out = subprocess.run(["pgrep", "-f", "run_rag_test.py"], capture_output=True, text=True).stdout
        return [p for p in out.split() if p.strip() and int(p) != os.getpid()]
    except (OSError, ValueError):
        return []


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--file", default=os.path.join(here, "RAG_Test_Sheet_Lectures_1-3_results.xlsx"))
    p.add_argument("--model", default=os.environ.get("GRADER_MODEL", "gpt-6-luna"))
    p.add_argument("--effort", default="low", choices=["low", "medium", "high"])
    p.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--regrade", action="store_true", help="grade rows again whose Notes start with AUTO:")
    p.add_argument("--force", action="store_true", help="run even if run_rag_test.py seems to be running")
    args = p.parse_args()

    if not os.path.exists(args.file):
        raise SystemExit(f"{args.file} not found. Run run_rag_test.py first.")
    if not args.force and answering_in_progress():
        raise SystemExit("run_rag_test.py is still running and writes the same file. "
                         "Wait for it to finish (or pass --force).")
    key = read_key(here)

    wb = openpyxl.load_workbook(args.file)
    ws = wb[SHEET]
    todo = []
    for row in range(2, ws.max_row + 1):
        answer = ws.cell(row, COL_SYSTEM_ANSWER).value
        if answer in (None, ""):
            continue
        status = ws.cell(row, COL_MATCH).value
        auto = str(ws.cell(row, COL_NOTES).value or "").startswith("AUTO:")
        if status not in (None, "") and not (args.regrade and auto):
            continue
        todo.append((row, str(ws.cell(row, COL_QUESTION).value), str(ws.cell(row, COL_VERIFIED).value), str(answer)))
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        print("Nothing to grade.")
        return
    print(f"Grading {len(todo)} answer(s) with {args.model}, {args.workers} at a time.\n")

    done = failed = 0
    started = time.time()
    stopped = None
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(judge, key, args.base_url, args.model, args.effort, q, v, a): row for row, q, v, a in todo}
        for fut in as_completed(futs):
            row = futs[fut]
            try:
                status, reason = fut.result()
            except StopRun as e:
                stopped = str(e)
                for f in futs:
                    f.cancel()
                break
            except Exception as e:
                failed += 1
                print(f"row {row}: grading failed ({str(e)[:120]})", flush=True)
                continue
            ws.cell(row, COL_MATCH).value = status
            ws.cell(row, COL_NOTES).value = f"AUTO: {reason}"[:500]
            done += 1
            if done % 10 == 0 or done == len(todo):
                save(wb, args.file)
                eta = (time.time() - started) / done * (len(todo) - done - failed) / 60
                print(f"[{done}/{len(todo)}] graded | ~{eta:.0f} min left", flush=True)
    save(wb, args.file)

    counts = collections.defaultdict(collections.Counter)
    for row in range(2, ws.max_row + 1):
        lec, status = ws.cell(row, COL_LECTURE).value, ws.cell(row, COL_MATCH).value
        if lec not in (None, "") and status:
            counts[str(lec)][status] += 1
    print("\nLecture | " + " | ".join(STATUSES) + " | % Correct")
    for lec in sorted(counts):
        c = counts[lec]
        total = sum(c.values())
        print(f"{lec:>7} | " + " | ".join(str(c[s]) for s in STATUSES) + f" | {100 * c['Correct'] / total:.1f}%")
    print(f"\n{done} graded, {failed} failed. Results: {args.file}")
    if stopped:
        raise SystemExit(f"Stopped early: {stopped}")


if __name__ == "__main__":
    sys.exit(main())
