import { expect, it, vi } from 'vitest';
import { listCurrentRoles } from '../../lib/auth/roles';

const authorization = (id: number, key = 'docs:manual:reader', userId = 'reader', projectId = 'project', state = 'STATE_ACTIVE') => ({
  id: `authorization-${id}`, user: { id: userId }, project: { id: projectId }, state, roles: [{ key }],
});
const response = (totalResult: number, authorizations: unknown[], appliedLimit = 100) =>
  new Response(JSON.stringify({ pagination: { totalResult, appliedLimit }, authorizations }));

it('requests only the authenticated subject, configured project and active assignments', async () => {
  const fetcher = vi.fn(async (endpoint: RequestInfo | URL, init?: RequestInit) => {
    void endpoint; void init;
    return response(2, [authorization(1, 'librarian-admin'), authorization(2)]);
  });
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', fetcher)).resolves
    .toEqual(['docs:manual:reader', 'librarian-admin']);
  const [endpoint, init] = fetcher.mock.calls[0];
  expect(String(endpoint)).toBe('https://identity.example/zitadel.authorization.v2.AuthorizationService/ListAuthorizations');
  expect(new Headers(init?.headers).get('connect-protocol-version')).toBe('1');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer opaque-token');
  expect(JSON.parse(String(init?.body))).toMatchObject({ pagination: { offset: 0, limit: 100 }, filters: [
    { inUserIds: { ids: ['reader'] } }, { projectId: { id: 'project' } }, { state: { state: 'STATE_ACTIVE' } },
  ] });
});

it('requires complete bounded pagination and merges the roles from all pages', async () => {
  const authorizations = Array.from({ length: 101 }, (_, index) => authorization(index));
  const fetcher = vi.fn(async (_endpoint: RequestInfo | URL, init?: RequestInit) => {
    const offset = (JSON.parse(String(init?.body)) as { pagination: { offset: number } }).pagination.offset;
    return response(101, authorizations.slice(offset, offset + 100));
  });
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', fetcher))
    .resolves.toEqual(['docs:manual:reader']);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).pagination.offset).toBe(100);
});

it('fails closed on malformed, incomplete, mismatched, inactive or oversized assignments', async () => {
  for (const result of [
    new Response('{}'),
    response(1, []),
    response(101, [authorization(1)], 10),
    response(1, [authorization(1, 'reader', 'different-user')]),
    response(1, [authorization(1, 'reader', 'reader', 'different-project')]),
    response(1, [authorization(1, 'reader', 'reader', 'project', 'STATE_INACTIVE')]),
    response(1, [{ ...authorization(1), roles: [] }]),
    response(1, [{ ...authorization(1), roles: [{ key: 'bad\nrole' }] }]),
  ]) {
    await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () => result.clone()))
      .rejects.toThrow('role_verification_failed');
  }
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () => new Response('{}', { status: 503 })))
    .rejects.toThrow('role_verification_failed');
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () =>
    new Response(new Uint8Array(512 * 1024 + 1)))).rejects.toThrow('role_verification_failed');
});

it('accepts a complete empty result as verified denial', async () => {
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () => response(0, [], 0))).resolves.toEqual([]);
});

it('accepts decimal-string pagination, rejects contradictory empty pages, and stops at the page bound', async () => {
  const numericStrings = new Response(JSON.stringify({ pagination: { totalResult: '1', appliedLimit: '1' }, authorizations: [authorization(1)] }));
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () => numericStrings.clone()))
    .resolves.toEqual(['docs:manual:reader']);
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () => response(0, [authorization(1)], 0)))
    .rejects.toThrow('role_verification_failed');

  const fetcher = vi.fn(async (_endpoint: RequestInfo | URL, init?: RequestInit) => {
    const offset = (JSON.parse(String(init?.body)) as { pagination: { offset: number } }).pagination.offset;
    return response(11, [authorization(offset)], 1);
  });
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', fetcher))
    .rejects.toThrow('role_verification_failed');
  expect(fetcher).toHaveBeenCalledTimes(10);
});

it('rejects missing, malformed, inconsistent, duplicate, and out-of-range role pages', async () => {
  const malformed = [
    new Response(null),
    new Response('not-json'),
    new Response('[]'),
    new Response(JSON.stringify({ pagination: { totalResult: 'many', appliedLimit: 100 }, authorizations: [] })),
    new Response(JSON.stringify({ pagination: { totalResult: 1001, appliedLimit: 100 }, authorizations: [] })),
    new Response(JSON.stringify({ pagination: { totalResult: 1, appliedLimit: 101 }, authorizations: [authorization(1)] })),
    new Response(JSON.stringify({ pagination: { totalResult: 1, appliedLimit: 1 }, authorizations: [] })),
    response(1, [null]),
    response(1, [{ ...authorization(1), id: '' }]),
    response(1, [{ ...authorization(1), roles: [{ key: '' }] }]),
    response(1, [{ ...authorization(1), roles: [{ key: 'x'.repeat(201) }] }]),
    response(1, [{ ...authorization(1), roles: [null] }]),
  ];
  for (const result of malformed) {
    await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () => result.clone()))
      .rejects.toThrow('role_verification_failed');
  }

  const duplicateId = [authorization(1), authorization(1)];
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', async () => response(2, duplicateId)))
    .rejects.toThrow('role_verification_failed');

  const firstPage = Array.from({ length: 100 }, (_, index) => authorization(index));
  const changingPages = vi.fn(async (_endpoint: RequestInfo | URL, init?: RequestInit) => {
    const offset = (JSON.parse(String(init?.body)) as { pagination: { offset: number } }).pagination.offset;
    return offset === 0 ? response(101, firstPage) : response(102, [authorization(101)]);
  });
  await expect(listCurrentRoles('https://identity.example', 'reader', 'project', 'opaque-token', changingPages))
    .rejects.toThrow('role_verification_failed');
});
