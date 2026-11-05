import { readFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { expect } from '@playwright/test';

export async function refreshAdminAuthorization() {
  const { dbName } = JSON.parse(await readFile('.local/browser-state.json', 'utf8')) as { dbName: string };
  if (!/^librarian_browser_[a-f0-9]{32}$/.test(dbName)) throw new Error('Disposable browser fixture database required');
  const client = new MongoClient(`mongodb://127.0.0.1:27018/${dbName}`);
  try {
    await client.connect();
    // A serial cross-browser run can outlast the real role freshness deadline.
    const refreshed = await client.db(dbName).collection('identity_authorizations').updateOne(
      { issuer: 'https://identity.synthetic.invalid', subject: 'synthetic-browser-admin-subject', projectId: 'synthetic-project' },
      { $set: { verifiedAt: new Date() } });
    expect(refreshed.matchedCount).toBe(1);
  } finally { await client.close(); }
}
