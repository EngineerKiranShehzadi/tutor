"""
Local embedding HTTP server using BAAI/bge-large-en-v1.5.
Node.js backend calls this at runtime for student question embedding.
Usage: python scripts/embedding_server.py
Runs on port 5001.
"""
import os
import sys
from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer, CrossEncoder

MODEL_NAME = "BAAI/bge-large-en-v1.5"
RERANKER_MODEL_NAME = "BAAI/bge-reranker-large"
# BGE retrieval models expect this instruction prepended to queries (not to
# indexed passages) to get well-separated query/passage embeddings.
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "

print(f"Loading model {MODEL_NAME} ...")
model = SentenceTransformer(MODEL_NAME)
print(f"Loading reranker {RERANKER_MODEL_NAME} ...")
reranker = CrossEncoder(RERANKER_MODEL_NAME)
print("Models ready. Starting server on port 5001 ...")

app = Flask(__name__)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model': MODEL_NAME, 'dims': model.get_sentence_embedding_dimension()})

@app.route('/embed', methods=['POST'])
def embed():
    data = request.get_json()
    if not data or 'text' not in data:
        return jsonify({'error': 'Missing text field'}), 400
    text = data['text']
    if data.get('is_query'):
        text = QUERY_INSTRUCTION + text
    embedding = model.encode(text, normalize_embeddings=True).tolist()
    return jsonify({'embedding': embedding, 'dims': len(embedding)})

@app.route('/rerank', methods=['POST'])
def rerank():
    data = request.get_json()
    if not data or 'query' not in data or 'candidates' not in data:
        return jsonify({'error': 'Missing query or candidates field'}), 400
    query = data['query']
    candidates = data['candidates']  # list of {id, text}
    pairs = [[query, c['text']] for c in candidates]
    scores = reranker.predict(pairs).tolist()
    results = sorted(
        [{'id': c['id'], 'score': score} for c, score in zip(candidates, scores)],
        key=lambda r: r['score'],
        reverse=True,
    )
    return jsonify({'results': results})

if __name__ == '__main__':
    port = int(os.environ.get('EMBEDDING_PORT', 5001))
    app.run(host='0.0.0.0', port=port, debug=False)
