from flask import Flask, request, jsonify
from sentence_transformers import SentenceTransformer, CrossEncoder

MODEL_NAME = "BAAI/bge-large-en-v1.5"
RERANKER_MODEL_NAME = "BAAI/bge-reranker-large"
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "

app = Flask(__name__)
model = SentenceTransformer(MODEL_NAME)
reranker = CrossEncoder(RERANKER_MODEL_NAME)

@app.route('/embed', methods=['POST'])
def embed():
    text = request.json.get('text', '')
    if request.json.get('is_query'):
        text = QUERY_INSTRUCTION + text
    embedding = model.encode(text, normalize_embeddings=True).tolist()
    return jsonify({'embedding': embedding})

@app.route('/rerank', methods=['POST'])
def rerank():
    data = request.get_json()
    if not data or 'query' not in data or 'candidates' not in data:
        return jsonify({'error': 'Missing query or candidates field'}), 400
    query = data['query']
    candidates = data['candidates']
    pairs = [[query, c['text']] for c in candidates]
    scores = reranker.predict(pairs).tolist()
    results = sorted(
        [{'id': c['id'], 'score': score} for c, score in zip(candidates, scores)],
        key=lambda r: r['score'],
        reverse=True,
    )
    return jsonify({'results': results})

if __name__ == '__main__':
    print("Embedding server running on http://localhost:5001")
    app.run(host='0.0.0.0', port=5001)
