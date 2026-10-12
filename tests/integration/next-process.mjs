import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const [appRoot, port] = process.argv.slice(2);
const cli = resolve(appRoot, 'node_modules/next/dist/bin/next');
process.argv = [process.execPath, cli, 'start', '--hostname', '127.0.0.1', '--port', port];
// Windows kill() cannot deliver SIGTERM handlers; IPC lets Next flush coverage on exit.
process.on('message', message => {
  if (message === 'shutdown') process.emit('SIGTERM', 'SIGTERM');
});
process.on('exit', () => {
  if (process.env.LIBRARIAN_INSTRUMENTED_CAPTURE) writeFileSync(process.env.LIBRARIAN_INSTRUMENTED_CAPTURE, JSON.stringify(globalThis.__VITEST_COVERAGE__ ?? {}));
});
await import(pathToFileURL(cli).href);
