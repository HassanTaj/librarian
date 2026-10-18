import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const stateFile = resolve('.local/browser-state.json');

export default async function globalTeardown() {
  try { await access(stateFile); }
  catch { return; }

  const response = await fetch('http://127.0.0.1:3101/shutdown', { method: 'POST', signal: AbortSignal.timeout(5_000) });
  if (response.status !== 204) throw new Error('Browser fixture did not accept its shutdown request.');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await access(stateFile); }
    catch { return; }
    await delay(100);
  }
  throw new Error('Browser fixture did not finish cleanup after its shutdown request.');
}
