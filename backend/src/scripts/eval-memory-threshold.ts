/**
 * Threshold-tuning utility for semantic answer memory
 * (RAG_MEMORY_SIMILARITY_THRESHOLD). Embeds a labeled set of question
 * pairs with the real retrieval embedding model, computes cosine
 * similarity for each pair, then sweeps candidate thresholds and reports
 * precision/recall so a real, evaluated value can be chosen instead of a
 * guessed one — semantic memory stays disabled by default until this has
 * been run against real lecture questions.
 *
 * For answer reuse, a wrong cached answer is worse than a missed reuse
 * opportunity, so pick the highest threshold that still gives acceptable
 * recall, not the one that maximizes recall.
 *
 * Requires the local embedding server (python scripts/embedding_server.py)
 * to be running — this uses the exact same model/endpoint as retrieval and
 * answer-memory, on purpose, so the numbers reported here are meaningful
 * for that config, not a proxy.
 *
 * Usage: npm run eval:memory-threshold
 */
import { generateEmbedding, EMBEDDING_MODEL_VERSION } from '../services/embedding.service';
import { logger } from '../utils/logger';

type Label = 'equivalent' | 'same-topic-different-intent' | 'unrelated';

interface LabeledPair {
  a: string;
  b: string;
  label: Label;
}

// Extend this set with real, project-specific lecture questions before
// trusting a threshold in production — this seed set is illustrative.
const DATASET: LabeledPair[] = [
  { a: 'What is cosine similarity?', b: 'Can you define cosine similarity?', label: 'equivalent' },
  { a: 'What is cosine similarity?', b: 'Explain the meaning of cosine similarity.', label: 'equivalent' },
  { a: 'What is OTP hashing?', b: 'Can you explain what OTP hashing means?', label: 'equivalent' },
  { a: 'What is RAG?', b: 'What does RAG stand for and mean?', label: 'equivalent' },
  { a: 'What is vector search?', b: 'Define vector search for me.', label: 'equivalent' },

  { a: 'What is cosine similarity?', b: 'How is cosine similarity calculated?', label: 'same-topic-different-intent' },
  { a: 'What is cosine similarity?', b: 'What are the disadvantages of cosine similarity?', label: 'same-topic-different-intent' },
  { a: 'What is cosine similarity?', b: 'Why is cosine similarity used in this project?', label: 'same-topic-different-intent' },
  { a: 'What is cosine similarity?', b: 'Compare cosine similarity and Euclidean distance.', label: 'same-topic-different-intent' },
  { a: 'What is OTP hashing?', b: 'Why is hashing an OTP necessary?', label: 'same-topic-different-intent' },
  { a: 'What is vector search?', b: 'What are the limitations of vector search?', label: 'same-topic-different-intent' },

  { a: 'What is cosine similarity?', b: 'What is a lecture summary used for?', label: 'unrelated' },
  { a: 'What is OTP hashing?', b: 'How does the cross-encoder reranker work?', label: 'unrelated' },
  { a: 'What is RAG?', b: 'What is a greeting route for?', label: 'unrelated' },
  { a: 'What is vector search?', b: 'Explain prompt engineering basics.', label: 'unrelated' },
];

const THRESHOLDS = Array.from({ length: 20 }, (_, i) => 0.80 + i * 0.01); // 0.80 .. 0.99

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function main() {
  console.log(`Embedding model: ${EMBEDDING_MODEL_VERSION}`);
  console.log(`Dataset: ${DATASET.length} labeled pairs\n`);

  const scored: (LabeledPair & { similarity: number; embedMsA: number; embedMsB: number })[] = [];

  for (const pair of DATASET) {
    let embA: number[], embB: number[], msA: number, msB: number;
    try {
      let t0 = Date.now();
      embA = await generateEmbedding(pair.a, true);
      msA = Date.now() - t0;
      t0 = Date.now();
      embB = await generateEmbedding(pair.b, true);
      msB = Date.now() - t0;
    } catch (err) {
      console.error(`Embedding failed — is the local embedding server running? (${(err as Error).message})`);
      process.exit(1);
    }
    const similarity = cosineSim(embA, embB);
    scored.push({ ...pair, similarity, embedMsA: msA, embedMsB: msB });
    console.log(`[${pair.label.padEnd(28)}] sim=${similarity.toFixed(4)}  "${pair.a}" <-> "${pair.b}"`);
  }

  const avgEmbedMs = scored.reduce((s, r) => s + r.embedMsA + r.embedMsB, 0) / (scored.length * 2);

  console.log('\n--- Threshold sweep (precision prioritized over recall) ---');
  console.log('threshold | truePos | falsePos | misses | precision | recall');

  let best: { threshold: number; precision: number; recall: number } | null = null;

  for (const threshold of THRESHOLDS) {
    const truePos  = scored.filter(r => r.label === 'equivalent' && r.similarity >= threshold).length;
    const falsePos = scored.filter(r => r.label !== 'equivalent' && r.similarity >= threshold).length;
    const misses   = scored.filter(r => r.label === 'equivalent' && r.similarity < threshold).length;
    const precision = truePos + falsePos > 0 ? truePos / (truePos + falsePos) : 1; // no reuse attempted = trivially precise
    const recall    = truePos + misses > 0 ? truePos / (truePos + misses) : 0;

    console.log(`${threshold.toFixed(2)}      | ${truePos}       | ${falsePos}        | ${misses}      | ${precision.toFixed(2)}      | ${recall.toFixed(2)}`);

    // Among thresholds with zero false reuse (perfect precision on this
    // dataset), prefer the one with the best recall — a missed cache
    // opportunity is fine, a wrong cached answer is not, so precision is
    // never traded away, but recall is still worth maximizing within that.
    if (falsePos === 0 && recall > 0 && (!best || recall > best.recall)) {
      best = { threshold, precision, recall };
    }
  }

  console.log(`\nAverage single-question embedding latency: ${avgEmbedMs.toFixed(0)}ms`);
  console.log('Gemini calls avoided per memory hit: 1 (answer generation) — plus the retrieval-side rerank/embedding calls skipped.');

  if (best) {
    console.log(`\nRecommended starting threshold: ${best.threshold.toFixed(2)} (precision=${best.precision.toFixed(2)}, recall=${best.recall.toFixed(2)}, zero false reuse on this dataset)`);
    console.log(`Set RAG_MEMORY_SEMANTIC_ENABLED=true and RAG_MEMORY_SIMILARITY_THRESHOLD=${best.threshold.toFixed(2)} only after expanding this dataset with real lecture questions and re-running.`);
  } else {
    console.log('\nNo threshold in the sweep range achieved zero false reuse on this dataset — expand THRESHOLDS or the dataset before enabling semantic memory.');
  }

  logger.info(`[EVAL] Memory threshold sweep complete over ${DATASET.length} pairs`);
}

main();
