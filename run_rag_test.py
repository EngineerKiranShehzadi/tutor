#!/usr/bin/env python3
"""Ask every question in the RAG test sheet to the running backend and save the answers.

For each row of Test_Sheet it logs in as the test student, opens a fresh chat
session on the right lecture (so earlier questions don't leak in as context),
asks the question, and writes the reply into System_Answer.

- The input file is never changed; answers go to a separate results file.
- The results file is saved after every answer. Run the script again to resume:
  rows that already have a System_Answer are skipped.
- A failed question gets "ERROR: ..." in Notes and an empty System_Answer, so a
  rerun retries it.
- Match_Status is left for grading (the dropdown in the sheet).

Usage:
  .venv/bin/python run_rag_test.py                 # all questions
  .venv/bin/python run_rag_test.py --limit 5       # quick check
  .venv/bin/python run_rag_test.py --lecture 2     # one lecture only
"""
import argparse
import os
import signal
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import openpyxl
import requests

# Sheet lecture number -> lecture id in the database. The ids are not 1, 2, 3
# (deleted lectures leave gaps), so they are checked against titles at startup.
LECTURE_IDS = {1: 2, 2: 5, 3: 6}
TITLE_CHECK = {1: ("lecture -1", "lecture 1"), 2: ("lecture 2",), 3: ("lecture 3",)}

SHEET = "Test_Sheet"
COL_LECTURE, COL_ID, COL_QUESTION = 1, 2, 3
COL_SYSTEM_ANSWER, COL_MATCH, COL_NOTES = 7, 8, 9

CREATE_SESSION = "mutation($l:Int!){createChatSession(lectureId:$l){id}}"
ASK = "mutation($i:AskLectureAgentInput!){askLectureAgent(input:$i){answer}}"
LECTURES = "{lectures{id title}}"


class Api:
    def __init__(self, base, email, password):
        self.base, self.email, self.password = base.rstrip("/"), email, password
        self.token = None
        self.lock = threading.Lock()

    def login(self, fatal=True, attempts=5):
        # A server or network error is retried with growing waits. Only the first
        # login stops the script; a re-login during the run reports an error for
        # that one question instead, so a short outage can't end the whole run.
        problem = None
        for attempt in range(1, attempts + 1):
            try:
                r = requests.post(f"{self.base}/api/v1/auth/login",
                                  json={"email": self.email, "password": self.password}, timeout=60)
                body = r.json() if r.content else {}
                token = (body.get("data") or {}).get("accessToken") or body.get("accessToken")
                if r.status_code == 200 and token:
                    self.token = token
                    return
                problem = f"Login failed ({r.status_code}): {body.get('message') or body}"
                if 400 <= r.status_code < 500 and r.status_code != 429:
                    break  # wrong email/password: retrying won't help
            except (requests.RequestException, ValueError) as e:
                problem = f"Login failed: {e}"
            if attempt < attempts:
                time.sleep(min(60, 5 * 2 ** (attempt - 1)))
        if fatal:
            raise SystemExit(problem)
        raise RuntimeError(problem)

    def gql(self, query, variables=None, timeout=300):
        for attempt in range(2):
            r = requests.post(f"{self.base}/graphql", json={"query": query, "variables": variables or {}},
                              headers={"Authorization": f"Bearer {self.token}"}, timeout=timeout)
            body = r.json()
            errors = body.get("errors") or []
            unauth = any((e.get("extensions") or {}).get("code") == "UNAUTHENTICATED" for e in errors)
            if unauth and attempt == 0:
                # The backend also answers "Unauthorized" when its own database
                # lookup of the user fails, so log in again before retrying.
                with self.lock:
                    self.login(fatal=False)
                continue
            if errors:
                e = errors[0]
                code = (e.get("extensions") or {}).get("code")
                raise RuntimeError(f"{code + ': ' if code else ''}{e.get('message')}")
            return body["data"]
        raise RuntimeError("not authenticated")


def ask_one(api, lecture_id, question, retries=5):
    # Waits 10, 20, 30, 40 s between tries, so a network outage of about
    # 1.5 minutes doesn't lose the question.
    last = None
    for attempt in range(1, retries + 1):
        try:
            sid = api.gql(CREATE_SESSION, {"l": lecture_id})["createChatSession"]["id"]
            data = api.gql(ASK, {"i": {"lectureId": lecture_id, "sessionId": sid, "question": question}})
            return data["askLectureAgent"]["answer"]
        except (requests.RequestException, ValueError, RuntimeError) as e:
            last = e
            if attempt < retries:
                time.sleep(10 * attempt)
    raise RuntimeError(str(last))


def save(wb, path):
    # Write to a temp file first so an interrupted save never corrupts the results.
    fd, tmp = tempfile.mkstemp(suffix=".xlsx", dir=os.path.dirname(os.path.abspath(path)))
    os.close(fd)
    wb.save(tmp)
    os.replace(tmp, path)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--input", default=os.path.join(here, "RAG_Test_Sheet_Lectures_1-3.xlsx"))
    p.add_argument("--output", default=None, help="default: <input>_results.xlsx")
    p.add_argument("--api", default=os.environ.get("RAG_TEST_API", "http://localhost:5000"))
    p.add_argument("--email", default=os.environ.get("RAG_TEST_EMAIL", "ragtest@local.test"))
    p.add_argument("--password", default=os.environ.get("RAG_TEST_PASSWORD", "ragtest123"))
    p.add_argument("--workers", type=int, default=4, help="questions asked at the same time")
    p.add_argument("--limit", type=int, default=0, help="stop after this many questions (0 = all)")
    p.add_argument("--lecture", type=int, choices=sorted(LECTURE_IDS), help="only this sheet lecture")
    args = p.parse_args()
    output = args.output or os.path.splitext(args.input)[0] + "_results.xlsx"

    api = Api(args.api, args.email, args.password)
    api.login()

    titles = {int(l["id"]): l["title"] for l in api.gql(LECTURES)["lectures"]}
    for n, lid in LECTURE_IDS.items():
        title = titles.get(lid, "")
        if not any(t in title.lower() for t in TITLE_CHECK[n]):
            raise SystemExit(f"Sheet lecture {n} should be database lecture {lid}, but that lecture's "
                             f"title is {title!r}. Fix LECTURE_IDS at the top of this script.")
        print(f"Lecture {n} -> id {lid}: {title}")

    resumed = os.path.exists(output)
    wb = openpyxl.load_workbook(output if resumed else args.input)
    ws = wb[SHEET]
    print(f"{'Resuming' if resumed else 'Writing'} results to {output}")

    todo = []
    for row in range(2, ws.max_row + 1):
        lec, question = ws.cell(row, COL_LECTURE).value, ws.cell(row, COL_QUESTION).value
        if lec in (None, "") or not question:
            continue
        lec = int(str(lec).strip())
        if args.lecture and lec != args.lecture:
            continue
        if ws.cell(row, COL_SYSTEM_ANSWER).value not in (None, ""):
            continue
        todo.append((row, lec, str(question).strip()))
    if args.limit:
        todo = todo[: args.limit]
    if not todo:
        print("Nothing to do: every selected question already has a System_Answer.")
        return

    print(f"Asking {len(todo)} question(s), {args.workers} at a time. Ctrl+C stops safely.\n")
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    def work(item):
        if stop.is_set():
            return item, None, "skipped"
        row, lec, q = item
        try:
            return item, ask_one(api, LECTURE_IDS[lec], q), None
        except Exception as e:  # recorded in Notes, retried on the next run
            return item, None, str(e)

    done = ok = failed = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for fut in as_completed([pool.submit(work, t) for t in todo]):
            (row, lec, q), answer, error = fut.result()
            if error == "skipped":
                continue
            done += 1
            if answer is not None:
                ok += 1
                ws.cell(row, COL_SYSTEM_ANSWER).value = answer
                notes = ws.cell(row, COL_NOTES)
                if str(notes.value or "").startswith("ERROR:"):
                    notes.value = None
            else:
                failed += 1
                ws.cell(row, COL_NOTES).value = f"ERROR: {error}"[:500]
            save(wb, output)
            rate = (time.time() - started) / done
            eta = rate * (len(todo) - done) / 60
            sheet_id = ws.cell(row, COL_ID).value
            status = "ok" if answer is not None else f"FAILED ({error[:80]})"
            print(f"[{done}/{len(todo)}] L{lec} Q{sheet_id}: {status} | ~{eta:.0f} min left", flush=True)

    mins = (time.time() - started) / 60
    print(f"\nDone in {mins:.1f} min: {ok} answered, {failed} failed"
          + (" (stopped early, run again to continue)" if stop.is_set() else "") + f".\nResults: {output}")
    if failed:
        print("Failed rows have 'ERROR: ...' in Notes. Run the script again to retry them.")


if __name__ == "__main__":
    sys.exit(main())
