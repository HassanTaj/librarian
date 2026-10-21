import { withRuntimeInstanceAdmission } from '../instance/access';
import type { Db } from 'mongodb';
import { CatalogSchema, isCatalogSlug, type Catalog } from '../catalog';
import { withGeneration, type GenerationPin, type Manifest } from '../content/generations';
import { getAuthContext, auth } from '../../auth';
import { getVerifiedRoles } from './roles';
import { getOAuthAccessToken } from './tokens';
import { ObjectId } from 'mongodb';

async function privateReader(db: Db, catalog: Catalog) {
  let context: Awaited<ReturnType<typeof getAuthContext>>;
  try { context = await getAuthContext(); } catch { throw new Error('unauthorized'); }
  const userId = context.session?.user?.id;
  if (typeof userId !== 'string' || !/^[a-f0-9]{24}$/i.test(userId)) throw new Error('unauthorized');
  const identityQuery = { provider: 'zitadel', issuer: context.config.zitadelIssuer, userId: new ObjectId(userId) };
  let account: { providerAccountId: string } | null;
  try { account = await db.collection<{ providerAccountId: string }>('accounts').findOne(identityQuery, { projection: { providerAccountId: 1 } }); }
  catch { throw new Error('storage_unavailable'); }
  if (!account || typeof account.providerAccountId !== 'string' || !account.providerAccountId) throw new Error('unauthorized');
  const identity = { issuer: context.config.zitadelIssuer, subject: account.providerAccountId, projectId: context.config.zitadelProjectId };
  try {
    const roles = await getVerifiedRoles(db, identity, () => getOAuthAccessToken(db, identity.issuer, identity.subject,
      context.config.zitadelClientId, context.config.zitadelSecret, context.config.oauthTokenEncryptionKey));
    if (!roles.includes(catalog.readerRole)) throw new Error('unauthorized');
  } catch (error) { if (error instanceof Error && error.message === 'storage_unavailable') throw error; throw new Error('unauthorized'); }
  let roleState: { verifiedAt?: Date } | null;
  try { roleState = await db.collection<{ verifiedAt?: Date }>('identity_authorizations').findOne(
    { issuer: identity.issuer, subject: identity.subject, projectId: identity.projectId }, { projection: { verifiedAt: 1 } }); }
  catch { throw new Error('storage_unavailable'); }
  if (!(roleState?.verifiedAt instanceof Date)) throw new Error('unauthorized');
  let current;
  try { current = await auth(); } catch { throw new Error('unauthorized'); }
  if (current?.user?.id !== userId) throw new Error('unauthorized');
  let accountStillLinked: { providerAccountId: string } | null;
  try { accountStillLinked = await db.collection<{ providerAccountId: string }>('accounts').findOne(identityQuery, { projection: { providerAccountId: 1 } }); }
  catch { throw new Error('storage_unavailable'); }
  if (accountStillLinked?.providerAccountId !== identity.subject) throw new Error('unauthorized');
  return roleState.verifiedAt.getTime();
}

export type AuthorizationContext = { privateContent: boolean; roleVerifiedAt: number | null };

export async function authorizeCatalog(db: Db, slug: string) {
  if (!isCatalogSlug(slug)) throw new Error('invalid_path');
  let catalog: Catalog | null;
  try {
    const value = await db.collection<Catalog>('catalogs').findOne({ slug });
    catalog = value ? CatalogSchema.parse(value) : null;
  } catch { throw new Error('storage_unavailable'); }
  if (!catalog?.enabled) throw new Error('not_found');
  if (catalog.accessState !== 'ready') throw new Error('content_unavailable');
  const roleVerifiedAt = catalog.visibility === 'private' ? await privateReader(db, catalog) : null;
  return { catalog, privateContent: roleVerifiedAt !== null, roleVerifiedAt };
}

export async function readAuthorizedGeneration<T>(db: Db, contentRoot: string, slug: string, generationId: string | undefined,
  read: (manifest: Manifest, signal: AbortSignal, pin: GenerationPin, authorization: AuthorizationContext) => Promise<T>, signal?: AbortSignal) {
  return withRuntimeInstanceAdmission(db, 'request', async () => {
  let authorization = await authorizeCatalog(db, slug);
  const { catalog } = authorization;
  const request = { catalogId: catalog._id, configRevision: catalog.configRevision, authEpoch: catalog.authEpoch, generationId };
  return withGeneration(db, contentRoot, request, async (manifest, abort, pin) => {
    async function recheck() {
      const current = await authorizeCatalog(db, slug);
      if (current.catalog._id !== catalog._id || current.catalog.configRevision !== catalog.configRevision || current.catalog.authEpoch !== catalog.authEpoch ||
          ![current.catalog.published, ...current.catalog.retained].some(pointer => pointer?.generationId === manifest.generationId)) throw new Error('reload_required');
      authorization = current;
      abort.throwIfAborted();
    }
    await recheck();
    const result = await read(manifest, abort, pin, authorization);
    await recheck();
    return result;
  }, signal);
  });
}
