/**
 * Dedicated sequential runner for `npm test`.
 *
 * Replaces the previous `npm run test:a && npm run test:b && ...` shell
 * chain. That chain invoked the npm CLI seven separate times — once per
 * `npm run` — and every one of those invocations independently races
 * npm's own background update-notifier network check (npm/lib/cli/
 * update-notifier.js, fetches the latest npm version from the registry on
 * a plain, un-awaited promise chain). In this environment that request
 * intermittently comes back with a non-JSON body, which npm's own code
 * doesn't catch — the resulting unhandled promise rejection crashes
 * whichever npm CLI process hit it, with exit code 1 and no readable
 * error, regardless of whether the wrapped test script itself passed.
 * With seven npm CLI invocations per `npm test` run (plus more inside
 * test-observability.ts/-capabilities.ts/-overview-metrics.ts, which used
 * to shell out to `npx ts-node` for isolated child processes), the odds
 * of hitting this at least once per run were high — hence "138/138 passed"
 * printed correctly while the overall command still exited 1.
 *
 * The fix has two parts:
 *   1. backend/.npmrc sets update-notifier=false, so the one remaining
 *      npm CLI process (the outer `npm test` invocation itself) never
 *      makes that network call.
 *   2. This runner, and the isolated-child-process test cases inside the
 *      suites below, invoke the local ts-node binary directly instead of
 *      going through `npm run` / `npx` — both of which re-enter the npm
 *      CLI. A direct binary invocation is a plain node process with no
 *      such side channel.
 *
 * Behavior:
 *   - Runs each suite sequentially (never in parallel — several suites
 *     share the same dev database rows and Phoenix project).
 *   - Streams each suite's stdout/stderr live (stdio: 'inherit').
 *   - Prints the suite name before it starts.
 *   - Stops immediately on the first suite that fails, propagating its
 *     exact exit code.
 *   - Exits 0 only when every suite exits 0.
 *
 * Usage: npm test  (== ts-node --transpile-only src/scripts/run-tests.ts)
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const TS_NODE_BIN = path.join(BACKEND_ROOT, 'node_modules', '.bin', 'ts-node');

interface Suite { name: string; script: string }

// Same suites, same order, as the shell chain this replaces.
const SUITES: Suite[] = [
  { name: 'observability-sanitize', script: 'src/scripts/test-observability-sanitize.ts' },
  { name: 'observability-hierarchy', script: 'src/scripts/test-observability-hierarchy.ts' },
  { name: 'observability-query', script: 'src/scripts/test-observability-query.ts' },
  { name: 'observability', script: 'src/scripts/test-observability.ts' },
  { name: 'observability-auth', script: 'src/scripts/test-observability-auth.ts' },
  { name: 'observability-capabilities', script: 'src/scripts/test-observability-capabilities.ts' },
  { name: 'observability-overview-metrics', script: 'src/scripts/test-observability-overview-metrics.ts' },
];

function main(): void {
  for (const suite of SUITES) {
    console.log(`\n=== ${suite.name} (npm run test:${suite.name}) ===`);
    const result = spawnSync(TS_NODE_BIN, ['--transpile-only', suite.script], {
      cwd: BACKEND_ROOT,
      stdio: 'inherit',
      env: process.env,
    });

    if (result.error) {
      console.error(`\nFAILED TO START  ${suite.name}: ${result.error.message}`);
      process.exit(1);
    }
    if (result.signal) {
      console.error(`\nKILLED  ${suite.name} (signal=${result.signal})`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`\nFAILED  ${suite.name} (exit code ${result.status})`);
      process.exit(result.status ?? 1);
    }
  }

  console.log(`\nAll ${SUITES.length} suites passed.`);
  process.exit(0);
}

main();
