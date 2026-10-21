import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createPinnedFetch, createProviderCheckRunner } from '../../lib/instance/validation';
import { readyInstance } from '../fixtures/instance';

it('uses verified TLS with pinned addresses and bounds real response streams and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'librarian-transport-'));
  const keyFile = join(root, 'key.pem'); const certificateFile = join(root, 'certificate.pem');
  const openssl = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe') : 'openssl';
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certificateFile,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE'], { windowsHide: true });
    const certificate = await readFile(certificateFile);
    let origin = '';
    server = createServer({ key: await readFile(keyFile), cert: certificate }, (request, response) => {
      if (request.url === '/declared-oversize') { response.writeHead(200, { 'content-length': '4096' }); response.end('x'.repeat(4096)); return; }
      if (request.url === '/stream-oversize') { response.writeHead(200); response.write('x'.repeat(700)); response.end('x'.repeat(700)); return; }
      if (request.url === '/hang') return;
      if (request.url === '/empty') { response.writeHead(204); response.end(); return; }
      if (request.url === '/cached') { response.writeHead(304); response.end(); return; }
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['synthetic-a=1', 'synthetic-b=2'] });
        response.end(JSON.stringify(request.url === '/.well-known/openid-configuration' ? {
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
        } : request.url === '/jwks' ? { keys: [{ ...publicKey, kid: 'synthetic-transport', alg: 'RS256' }] }
          : { method: request.method, body: Buffer.concat(chunks).toString(), header: request.headers['x-synthetic'] }));
      });
    });
    const { createPublicKey } = await import('node:crypto');
    const publicKey = createPublicKey(await readFile(keyFile)).export({ format: 'jwk' });
    server.listen(0); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable');
    origin = `https://localhost:${address.port}`;
    const policy = { origins: [{ origin, addresses: ['127.0.0.1'] }] };
    const pinned = createPinnedFetch({ policy, ca: { origin, certificate }, lookup: async () => ['127.0.0.1'], maxBytes: 1024 });
    const echo = await pinned(new Request(`${origin}/echo`, { method: 'POST', body: 'synthetic-request', headers: { 'x-synthetic': 'original' } }),
      { headers: { 'x-synthetic': 'replacement' } });
    expect(await echo.json()).toEqual({ method: 'POST', body: 'synthetic-request', header: 'replacement' });
    expect(echo.headers.get('set-cookie')).toContain('synthetic-a=1');
    expect(echo.headers.get('set-cookie')).toContain('synthetic-b=2');
    for (const body of ['string-body', new URLSearchParams({ value: 'form' }), new TextEncoder().encode('bytes').buffer]) {
      expect(await (await pinned(`${origin}/echo`, { method: 'POST', body })).json()).toMatchObject({ method: 'POST' });
    }
    for (const [path, status] of [['empty', 204], ['cached', 304]] as const) {
      const response = await pinned(`${origin}/${path}`); expect(response.status).toBe(status); expect(await response.text()).toBe('');
    }
    for (const path of ['declared-oversize', 'stream-oversize']) await expect(pinned(`${origin}/${path}`)).rejects.toThrow('response_invalid');
    await expect(createPinnedFetch({ policy, lookup: async () => ['127.0.0.1'] })(`${origin}/echo`)).rejects.toThrow('provider_unavailable');
    await expect(pinned(`${origin}/hang`, { signal: AbortSignal.abort() })).rejects.toThrow('provider_unavailable');
    const cancellation = new AbortController();
    const received = once(server, 'request');
    const pending = pinned(`${origin}/hang`, { signal: cancellation.signal });
    const rejected = expect(pending).rejects.toThrow('provider_unavailable');
    await received; cancellation.abort(); await rejected;
    const candidate = readyInstance().active!; candidate.zitadel.issuer = origin;
    const runner = createProviderCheckRunner({ policy, ca: { origin, certificate }, lookup: async () => ['127.0.0.1'] });
    expect(await runner.run('zitadel_discovery', candidate, {})).toMatchObject({ status: 'passed', code: 'provider_ok' });
    const { lookup } = await import('node:dns/promises');
    const addresses = (await lookup('localhost', { all: true, verbatim: true })).map(record => record.address);
    const direct = createPinnedFetch({ policy: { origins: [{ origin, addresses }] }, ca: { origin, certificate } });
    expect((await direct(`${origin}/echo`)).status).toBe(200);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
