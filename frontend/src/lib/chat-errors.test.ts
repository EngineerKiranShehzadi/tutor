// Unit tests for serverMessage (S3). The frontend has no test runner, so this
// is a plain script, run the same way as chat-session-guard.test.ts:
//
//   ../backend/node_modules/.bin/ts-node --transpile-only --skip-project \
//     --compiler-options '{"module":"commonjs","target":"es2020"}' src/lib/chat-errors.test.ts
import { serverMessage, FALLBACK_REPLY } from './chat-errors';
import { StreamServerError, StreamRateLimitedError, StreamUnavailableError } from './chat-stream';

let failures = 0;
let total = 0;
const check = (label: string, pass: boolean, detail = ''): void => {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
};
const reply = (err: unknown): string => serverMessage(err) ?? FALLBACK_REPLY;

const TOO_LONG = 'Your question is too long. Please shorten it and try again.';
const UNVERIFIED = "I couldn't check this answer against the lecture right now. Please ask again in a moment.";

// A too-long question refused by the input guardrail reaches the GraphQL path
// as an ApolloError whose first GraphQL error carries the server's text.
check('S3-1. GraphQL refusal ("question too long") is shown as-is',
  reply({ graphQLErrors: [{ message: TOO_LONG, extensions: { code: 'BAD_REQUEST' } }] }) === TOO_LONG);
check('S3-2. SSE error event (S1 verifier outage) is shown as-is',
  reply(new StreamServerError(UNVERIFIED)) === UNVERIFIED);
check('S3-3. Rate limit is still shown (stream 429 and GraphQL RATE_LIMITED)',
  reply(new StreamRateLimitedError('Too many questions. Please wait a moment.')) === 'Too many questions. Please wait a moment.'
  && reply({ graphQLErrors: [{ message: 'You have asked 30 questions in the last hour.', extensions: { code: 'RATE_LIMITED' } }] })
    === 'You have asked 30 questions in the last hour.');
check('S3-4. A network failure still shows the connection fallback',
  reply(new StreamUnavailableError('Could not reach the streaming endpoint')) === FALLBACK_REPLY
  && reply(new TypeError('Failed to fetch')) === FALLBACK_REPLY
  && reply({ networkError: new Error('offline'), graphQLErrors: [] }) === FALLBACK_REPLY);
check('S3-5. A masked internal GraphQL error, an empty message, null and undefined fall back',
  reply({ graphQLErrors: [{ message: 'Internal server error' }] }) === FALLBACK_REPLY
  && reply(new StreamServerError('')) === FALLBACK_REPLY
  && reply(null) === FALLBACK_REPLY && reply(undefined) === FALLBACK_REPLY);

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures === 0 ? 0 : 1);
