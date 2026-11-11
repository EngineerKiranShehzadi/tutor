import assert from 'assert/strict';

process.env.GEMINI_API_KEY = 'offline-test-gemini-key';
process.env.GEMINI_QUIZ_MAX_RPM = '10';

const { geminiLlmProvider } = require('../llm/providers/gemini-llm.provider') as typeof import('../llm/providers/gemini-llm.provider');
const savedFetch = globalThis.fetch;
const savedNow = Date.now;

async function run() {
  let now = 100_000;
  Date.now = () => now;
  let calls = 0;
  let sent: Record<string, unknown> | null = null;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.match(String(_url), /gemini-2\.5-flash-lite:generateContent/);
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'offline-test-gemini-key');
    sent = JSON.parse(String(init?.body));
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 7, totalTokenCount: 32 },
      }),
    } as Response;
  }) as typeof fetch;

  const result = await geminiLlmProvider.generate({
    model: 'gemini-2.5-flash-lite', systemPrompt: 'Quiz only', userPrompt: 'Generate grounded questions',
    thinking: 'off', timeoutMs: 5000,
    responseSchema: { type: 'OBJECT', properties: { questions: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['questions'] },
  });
  assert.equal(result.raw, '{"questions":[]}');
  assert.equal(result.provider, 'gemini');
  assert.equal(result.usage?.totalTokens, 32);
  assert.equal(calls, 1);
  const request = sent as unknown as { systemInstruction: unknown; generationConfig: { responseMimeType: string; responseJsonSchema: Record<string, unknown>; thinkingConfig: { thinkingBudget: number } } };
  assert.ok(request.systemInstruction);
  assert.equal(request.generationConfig.responseMimeType, 'application/json');
  assert.equal(request.generationConfig.responseJsonSchema.type, 'object');
  assert.equal(request.generationConfig.thinkingConfig.thinkingBudget, 0);

  const second = await geminiLlmProvider.generate({
    model: 'gemini-2.5-flash-lite', userPrompt: 'Verify quiz', timeoutMs: 5000,
  });
  assert.equal(second.provider, 'gemini');
  assert.equal(calls, 2);

  now += 60_000;
  globalThis.fetch = (async () => ({ ok: false, status: 429 }) as Response) as typeof fetch;
  await assert.rejects(
    geminiLlmProvider.generate({ model: 'gemini-2.5-flash-lite', userPrompt: 'Quiz' }),
    /rate limit or daily quota/
  );

  now += 60_000;
  globalThis.fetch = (async () => ({
    ok: true, json: async () => ({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }),
  } as Response)) as typeof fetch;
  await assert.rejects(
    geminiLlmProvider.generate({ model: 'gemini-2.5-flash-lite', userPrompt: 'Quiz' }),
    /empty or blocked/
  );
  now += 60_000;
  let unavailableAttempts = 0;
  globalThis.fetch = (async () => {
    unavailableAttempts++;
    if (unavailableAttempts === 1) return { ok: false, status: 503 } as Response;
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"questions":[]}' }] }, finishReason: 'STOP' }],
      }),
    } as Response;
  }) as typeof fetch;
  const recovered = await geminiLlmProvider.generate({
    model: 'gemini-3.5-flash-lite', userPrompt: 'Quiz retry', timeoutMs: 10000,
  });
  assert.equal(recovered.raw, '{"questions":[]}');
  assert.equal(unavailableAttempts, 2);

  now += 60_000;
  let permanentAttempts = 0;
  globalThis.fetch = (async () => {
    permanentAttempts++;
    return { ok: false, status: 503 } as Response;
  }) as typeof fetch;
  await assert.rejects(
    geminiLlmProvider.generate({ model: 'gemini-3.5-flash-lite', userPrompt: 'Quiz retry', timeoutMs: 10000 }),
    /temporarily overloaded/
  );
  assert.equal(permanentAttempts, 2);

  console.log('Quiz-only Gemini structured output and quota failure tests passed');
}

run().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = savedFetch;
  Date.now = savedNow;
});
