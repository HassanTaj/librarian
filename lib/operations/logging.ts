import { z } from 'zod';

const messages = {
  invalid_content: 'Documentation validation failed.',
  invalid_path: 'The requested path is invalid.',
  storage_unavailable: 'Documentation storage is unavailable.',
  content_unavailable: 'Documentation is not available yet.',
  reload_required: 'Reload to use the current documentation generation.',
  unauthorized: 'Sign in to continue.',
  forbidden: 'Access to this documentation is denied.',
  capacity_exceeded: 'The operation exceeds the configured capacity.',
  upstream_unavailable: 'The source provider is unavailable.',
  access_lost: 'Source access must be restored before documentation can be served.',
  operation_failed: 'The operation could not be completed.',
} as const;

export function operationError(error: unknown) {
  const code = error instanceof Error && Object.hasOwn(messages, error.message) ? error.message as keyof typeof messages : 'operation_failed';
  return { code, message: messages[code] };
}

const contextFields = {
  catalogId: z.uuidv4(), jobId: z.string().max(200).regex(/^(?:manual:[a-f0-9-]{36}:[a-f0-9-]{36}|github:[1-9]\d{0,15}:[a-f0-9-]{36}:[a-f0-9-]{36})$/),
  deliveryId: z.uuidv4(), generationId: z.uuidv4(), fence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

export function operationEvent(error: unknown, context: unknown) {
  const entry: Record<string, string | number> = operationError(error);
  if (context && typeof context === 'object') for (const [key, schema] of Object.entries(contextFields)) {
    const parsed = schema.safeParse(Reflect.get(context, key));
    if (parsed.success) entry[key] = parsed.data;
  }
  return entry;
}

const instanceContextFields = {
  instanceId: z.uuid(), requestId: z.uuid(), activationId: z.uuid(),
  operation: z.enum(['candidate_saved', 'setup_finalized', 'activated', 'rollback', 'owner_enrolled', 'owner_transferred', 'recovered', 'key_rotated']),
  resultCode: z.enum(['accepted', 'denied', 'failed', 'stale', 'unavailable', 'provider_unavailable', 'invalid_transition', 'revision_conflict', 'rate_limited', 'expired']),
  fromVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), toVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  editRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};

export function instanceOperationEvent(error: unknown, context: unknown) {
  const entry: Record<string, string | number | null> = operationError(error);
  if (context && typeof context === 'object') for (const [key, schema] of Object.entries(instanceContextFields)) {
    const parsed = schema.safeParse(Reflect.get(context, key));
    if (parsed.success) entry[key] = parsed.data;
  }
  return entry;
}
