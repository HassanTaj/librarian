import type { Db, MongoClient } from 'mongodb';
import type { InstanceKeyring } from '../../lib/instance/secrets';
import { attachInstanceKeyring, readInstance, serializeInstanceControl, type InstanceControl, type StoredInstanceControl } from '../../lib/instance/store';

type MemoryInstanceDbOptions = {
  configuration?: object;
  collections?: Record<string, object>;
  replace?: (filter: unknown, next: StoredInstanceControl) => Promise<{ matchedCount: number }>;
};

export function encryptedInstanceDb(control: InstanceControl, keyring: InstanceKeyring, options: MemoryInstanceDbOptions = {}) {
  let stored = serializeInstanceControl(control, control.instanceId, keyring);
  const client = {} as MongoClient;
  const configuration = {
    ...options.configuration,
    findOne: async () => structuredClone(await stored),
    replaceOne: async (filter: unknown, next: StoredInstanceControl) => {
      const result = await options.replace?.(filter, next) ?? { matchedCount: 1 };
      if (result.matchedCount === 1) {
        stored = Promise.resolve(structuredClone(next));
        const latest = await readInstance(db, control.instanceId);
        if (latest) Object.assign(control, latest);
      }
      return result;
    },
  };
  const db = {
    client,
    collection(name: string) {
      return (name === 'instance_configuration' ? configuration : options.collections?.[name] ?? { findOne: async () => null }) as never;
    },
  } as unknown as Db;
  attachInstanceKeyring(db, keyring);
  return {
    db,
    async setControl(next: InstanceControl) {
      Object.assign(control, next);
      stored = serializeInstanceControl(next, next.instanceId, keyring);
    },
  };
}
