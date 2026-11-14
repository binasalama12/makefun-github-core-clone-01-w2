// main.ts — the entrypoint: boot the forge, tell the environment where
// it lives, and stay alive until the environment says the trial is over.
//
// Lifecycle, in order:
//   1. MAKEFUN_ENV_URL must name the environment; without it, exit 1.
//   2. The server from app.ts listens on port 0 (the kernel chooses).
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register, retrying while the
//      environment is still starting; a 200 or 409 settles it.
//   4. Poll GET $MAKEFUN_ENV_URL/done with a short backoff until the
//      answer is {"done": true}.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; exiting\n');
  process.exit(1);
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff between environment calls, capped at two seconds. */
function backoff(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** Math.min(attempt, 3));
}

async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register refused with HTTP ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet is just "not done": keep polling.
    }
    await pause(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no TCP port was bound'));
      else resolve(address.port);
    });
  });
  process.stdout.write(`[forge] listening on ${port}\n`);
  await announce(port);
  process.stdout.write('[forge] registered; waiting for done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
