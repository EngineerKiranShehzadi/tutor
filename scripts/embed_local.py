"""
Batch embed lecture_qna_chunks using BAAI/bge-large-en-v1.5.
Writes 1024-dim vectors into the local_embedding column.
Usage: python scripts/embed_local.py [LECTURE_ID]
"""
import os
import sys
import psycopg2
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '..', 'backend', '.env'))

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    print("ERROR: DATABASE_URL not found in backend/.env")
    sys.exit(1)

LECTURE_ID = int(sys.argv[1]) if len(sys.argv) > 1 else 2

print(f"Loading model BAAI/bge-large-en-v1.5 ...")
model = SentenceTransformer("BAAI/bge-large-en-v1.5")
print("Model loaded.")

conn = psycopg2.connect(DATABASE_URL)
cur = conn.cursor()

cur.execute("""
    SELECT id, chunk_text
    FROM lecture_qna_chunks
    WHERE lecture_id = %s
      AND local_embedding IS NULL
    ORDER BY id ASC
""", (LECTURE_ID,))

rows = cur.fetchall()
total = len(rows)
print(f"Pending chunks: {total}")

if total == 0:
    print("Nothing to embed.")
    cur.execute("UPDATE lectures SET status = 'READY' WHERE id = %s", (LECTURE_ID,))
    conn.commit()
    cur.close()
    conn.close()
    sys.exit(0)

# Set lecture status to EMBEDDING and init progress
cur.execute("""
    UPDATE lectures
    SET status = 'EMBEDDING', progress_current = 0, progress_total = %s
    WHERE id = %s
""", (total, LECTURE_ID))
conn.commit()

for index, (chunk_id, chunk_text) in enumerate(rows, start=1):
    embedding = model.encode(chunk_text, normalize_embeddings=True).tolist()
    vector_string = "[" + ",".join(str(x) for x in embedding) + "]"

    cur.execute("""
        UPDATE lecture_qna_chunks
        SET local_embedding = %s::vector
        WHERE id = %s
    """, (vector_string, chunk_id))

    # Update progress every 50 chunks so frontend stays current
    if index % 50 == 0 or index == total:
        cur.execute(
            "UPDATE lectures SET progress_current = %s WHERE id = %s",
            (index, LECTURE_ID)
        )
        conn.commit()
        print(f"Embedded {index}/{total} chunks ({round(index/total*100)}%)")

# Mark lecture READY
cur.execute("UPDATE lectures SET status = 'READY', progress_current = %s WHERE id = %s", (total, LECTURE_ID))
conn.commit()
cur.close()
conn.close()
print("Done. Lecture marked READY.")
