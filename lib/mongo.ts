import { MongoClient } from 'mongodb';
import { loadConfig, loadHostConfig } from './config';
import { ensureCatalogStorage } from './catalog';
import { ensureSyncJobStorage } from './sync/jobs';

type MongoSettings = Pick<Awaited<ReturnType<typeof loadHostConfig>>, 'mongodbUri' | 'mongodbDatabase'> &
  Partial<Pick<Awaited<ReturnType<typeof loadHostConfig>>, 'contentRoot'>>;

export async function connectMongo(settings: MongoSettings, { initializeLegacy = true }: { initializeLegacy?: boolean } = {}) {
  let client: MongoClient | undefined;
  try {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(settings.mongodbDatabase) || ['admin', 'local', 'config'].includes(settings.mongodbDatabase)) throw new Error();
    client = new MongoClient(settings.mongodbUri, {
      maxPoolSize: 10, minPoolSize: 0, serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000, socketTimeoutMS: 30_000, readPreference: 'primary',
    });
    await client.connect();
    const hello = await client.db(settings.mongodbDatabase).command({ hello: 1 });
    if (!hello.isWritablePrimary || hello.maxWireVersion < 13) throw new Error();
    const db = client.db(settings.mongodbDatabase, {
      readPreference: 'primary', writeConcern: { w: hello.setName || hello.msg === 'isdbgrid' ? 'majority' : 1, j: true },
    });
    if (initializeLegacy) {
      await ensureCatalogStorage(db);
      await ensureSyncJobStorage(db);
    }
    return { client, db, contentRoot: settings.contentRoot };
  } catch {
    await client?.close();
    throw new Error('storage_unavailable');
  }
}

let connection: Promise<Awaited<ReturnType<typeof connectMongo>>> | undefined;

export function getMongo(settings?: MongoSettings): Promise<Awaited<ReturnType<typeof connectMongo>>> {
  if (!settings && (process.env.INSTANCE_ID || process.env.INSTANCE_STATE_FILE)) return loadConfig().then(config => getMongo(config));
  connection ??= (settings ? Promise.resolve(settings) : loadConfig()).then(connectMongo).catch(() => {
    connection = undefined;
    throw new Error('storage_unavailable');
  });
  return connection;
}

export async function closeMongo() {
  const pending = connection;
  connection = undefined;
  if (pending) await (await pending).client.close();
}
