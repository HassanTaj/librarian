import { afterEach, expect, it, vi } from 'vitest';
import { runtimeProviderFetch } from '../../lib/instance/validation';

const state = vi.hoisted(() => ({ host: vi.fn(), readFile: vi.fn() }));
vi.mock('../../lib/instance/bootstrap', () => ({ readInstanceHost: state.host }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), readFile: state.readFile }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('constrains runtime token and role fetches to the issuer and uses a development CA only for an approved localhost origin', async () => {
  vi.stubEnv('INSTANCE_ID', 'synthetic-instance'); vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('LIBRARIAN_TEST_PROVIDER_CA_FILE', '.local/synthetic-provider-ca.pem');
  const issuer = 'https://localhost:3227';
  state.host.mockResolvedValue({ policy: { origins: [{ origin: issuer, addresses: ['127.0.0.1'] }] } });
  state.readFile.mockResolvedValue(Buffer.from('synthetic-ca'));
  const fetcher = await runtimeProviderFetch(issuer);
  expect(state.readFile).toHaveBeenCalledWith('.local/synthetic-provider-ca.pem');
  for (const input of ['https://attacker.example.test/token', new Request('https://attacker.example.test/token')]) {
    expect(() => fetcher(input)).toThrow('instance_provider_url_invalid');
  }
  state.host.mockResolvedValue({ policy: { origins: [] } });
  const denied = await runtimeProviderFetch('https://127.0.0.1');
  await expect(denied(new Request('https://127.0.0.1/token'))).rejects.toThrow('provider_unavailable');
  expect(state.readFile).toHaveBeenCalledTimes(1);
});
