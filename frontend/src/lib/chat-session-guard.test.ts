// Unit tests for ChatSessionGuard (Step 7A.1 — frontend half of the session
// isolation fix). The frontend has no test runner, so this is a plain script:
//
//   ../backend/node_modules/.bin/ts-node --transpile-only --skip-project \
//     --compiler-options '{"module":"commonjs","target":"es2020"}' src/lib/chat-session-guard.test.ts
//
// It exercises the guard exactly the way hooks/useChat.ts drives it, including
// the "late async response" race, with simulated promises instead of React.
import { ChatSessionGuard } from './chat-session-guard';

let failures = 0;
let total = 0;
const check = (label: string, pass: boolean, detail = ''): void => {
  total++;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` (${detail})` : ''}`);
};

const LECTURE_A = 4;
const LECTURE_B = 2;

// L1. Switching lectures never reuses the previous lecture's session id.
{
  const g = new ChatSessionGuard();
  const tA = g.begin(LECTURE_A);
  g.activate(tA, 100);
  check('L1a. lecture A session is usable for lecture A', g.sessionFor(LECTURE_A) === 100);

  const tB = g.begin(LECTURE_B);                         // user switches to lecture B
  check('L1b. right after the switch no session is available for B (still loading)', g.sessionFor(LECTURE_B) === null);
  check('L1c. A\'s session id is not available for A either once the selection moved on', g.sessionFor(LECTURE_A) === null);
  check('L1d. nothing is active, so a message sent now has no session to submit against', g.activeSessionId() === null);

  g.activate(tB, 300);
  check('L1e. B\'s own session becomes active for B', g.sessionFor(LECTURE_B) === 300);
  check('L1f. and still never for A', g.sessionFor(LECTURE_A) === null);
}

// M. A late response from the previous lecture cannot restore its session.
{
  const g = new ChatSessionGuard();
  const tokenA = g.begin(LECTURE_A);                     // lecture A starts loading its sessions...
  const tokenB = g.begin(LECTURE_B);                     // ...user switches before A's response arrives
  const appliedLate = g.activate(tokenA, 100);           // A's slow response finally lands
  check('M1. late activation for the old lecture is refused', appliedLate === false);
  check('M2. active session is still empty after the late response', g.activeSessionId() === null);
  check('M3. old token is reported as stale', g.isCurrent(tokenA) === false && g.isCurrent(tokenB) === true);

  g.activate(tokenB, 300);
  const appliedLate2 = g.activate(tokenA, 100);          // another late write after B is active
  check('M4. late response after B is active does not overwrite B\'s session', appliedLate2 === false && g.sessionFor(LECTURE_B) === 300);
  check('M5. old lecture still cannot get a session', g.sessionFor(LECTURE_A) === null);
}

// M6. A switch A -> B -> A: results of the FIRST visit to A are stale on the second.
{
  const g = new ChatSessionGuard();
  const first = g.begin(LECTURE_A);
  g.begin(LECTURE_B);
  const second = g.begin(LECTURE_A);
  check('M6a. first visit\'s token is stale after returning to A', g.activate(first, 111) === false);
  check('M6b. second visit\'s token works', g.activate(second, 222) === true && g.sessionFor(LECTURE_A) === 222);
}

// N. Same-lecture actions (select another session / create a new one) still work.
{
  const g = new ChatSessionGuard();
  const t = g.begin(LECTURE_A);
  g.activate(t, 100);
  const applied = g.activate(g.currentToken(), 101);     // selectSession / createNewSession
  check('N1. switching sessions within one lecture is allowed', applied && g.sessionFor(LECTURE_A) === 101);

  const pendingCreateToken = g.currentToken();           // createNewSession started...
  g.begin(LECTURE_B);                                    // ...user changes lecture before it resolves
  check('N2. a pending "new session" for the old lecture cannot activate after a lecture switch', g.activate(pendingCreateToken, 102) === false && g.activeSessionId() === null);
}

// N3. Invalid / unselected lecture ids never yield a session.
{
  const g = new ChatSessionGuard();
  g.begin(LECTURE_A);
  g.activate(g.currentToken(), 100);
  check('N3. an unrelated lecture id yields no session', g.sessionFor(999) === null && g.sessionFor(NaN) === null);
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures > 0 ? 1 : 0);
