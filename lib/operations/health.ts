import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Db } from 'mongodb';

export async function checkHealth(db: Db, contentRoot: string) {
  try {
    const [, directory] = await Promise.all([
      db.command({ ping: 1 }, { timeoutMS: 5000 }), stat(contentRoot), access(contentRoot, constants.R_OK | constants.W_OK),
    ]);
    if (!directory.isDirectory()) throw new Error();
    return { status: 'ok' as const };
  } catch { return { status: 'unavailable' as const }; }
}
