import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupOptions } from 'node:dns';
import { createPrivateKey, createPublicKey, createSign } from 'node:crypto';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import { parseDocument } from 'yaml';
import { INSTANCE_CHECK_CODES, type InstanceControl } from './store';

const dnsTimeoutMs = 5_000;
const connectTimeoutMs = 5_000;
const requestTimeoutMs = 10_000;
const workflowTimeoutMs = 30_000;
const responseBudget = 512 * 1024;
const maxJwksKeys = 100;

type CheckType = typeof import('./store').INSTANCE_CHECK_TYPES[number];
type CheckCode = typeof INSTANCE_CHECK_CODES[number];
type Candidate = NonNullable<InstanceControl['candidate']>;
type Credentials = { zitadelClientSecret?: string | null; githubPrivateKey?: string | null; githubWebhookSecret?: string | null };
type OutboundPolicy = { origins: Array<{ origin: string; addresses: string[] }> };
type RequestOptions = {
  address: string; servername: string; rejectUnauthorized: true; redirect: 'manual'; connectTimeoutMs: number; timeoutMs: number;
  maxBytes: number; method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal; ca?: string | Buffer;
};
type ProviderResponse = { statusCode: number; statusText?: string; headers: Record<string, string>; body: Uint8Array };
type Lookup = (hostname: string, options: { timeoutMs: number }) => Promise<string[]>;
type Request = (url: URL, options: RequestOptions) => Promise<ProviderResponse>;

class CheckFailure extends Error {
  constructor(readonly checkCode: CheckCode) { super(checkCode); }
}

function fail(code: CheckCode): never { throw new CheckFailure(code); }

export async function runtimeProviderFetch(issuer: string, maxBytes = responseBudget): Promise<typeof fetch> {
  if (!process.env.INSTANCE_ID && !process.env.INSTANCE_STATE_FILE) return fetch;
  const { readInstanceHost } = await import('./bootstrap');
  const host = await readInstanceHost();
  const caFile = process.env.NODE_ENV === 'development' && new URL(issuer).hostname === 'localhost' &&
    host.policy.origins.some(rule => rule.origin === issuer) ? process.env.LIBRARIAN_TEST_PROVIDER_CA_FILE : undefined;
  const pinned = createPinnedFetch({ policy: host.policy, maxBytes,
    ...(caFile ? { ca: { origin: issuer, certificate: await (await import('node:fs/promises')).readFile(caFile) } } : {}),
  });
  return (input, init) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : String(input));
    if (url.origin !== issuer) throw new Error('instance_provider_url_invalid');
    return pinned(input, init);
  };
}

function ipv4Number(address: string) {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, part) => value * BigInt(256) + BigInt(part), BigInt(0));
}

function inIpv4Range(address: string, range: string) {
  const [network, prefixText] = range.split('/');
  const value = ipv4Number(address);
  const base = ipv4Number(network);
  const prefix = Number(prefixText);
  if (value === null || base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const shift = BigInt(32 - prefix);
  return (value >> shift) === (base >> shift);
}

function ipv6Number(address: string) {
  if (isIP(address) !== 6 || address.includes('%')) return null;
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const embedded = ipv4Number(value.slice(lastColon + 1));
    if (embedded === null) return null;
    value = `${value.slice(0, lastColon)}:${(embedded >> BigInt(16)).toString(16)}:${(embedded & BigInt(0xffff)).toString(16)}`;
  }
  const sides = value.split('::');
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(':') : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((sides.length === 1 && missing !== 0) || (sides.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.some(group => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.reduce((number, group) => (number << BigInt(16)) + BigInt(`0x${group}`), BigInt(0));
}

function inIpv6Range(address: string, network: string, prefix: number) {
  const value = ipv6Number(address);
  const base = ipv6Number(network);
  return value !== null && base !== null && (value >> BigInt(128 - prefix)) === (base >> BigInt(128 - prefix));
}

function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return ![
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
    '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
  ].some(range => inIpv4Range(address, range));
  if (version !== 6) return false;
  const value = ipv6Number(address);
  if (value === null || (value >> BigInt(125)) !== BigInt(1)) return false;
  const mappedIpv4 = (value >> BigInt(32)) === BigInt(0xffff);
  return !mappedIpv4 && ![
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16],
  ].some(([network, prefix]) => inIpv6Range(address, network as string, prefix as number));
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, code: CheckCode = 'request_timeout'): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([operation, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new CheckFailure(code)), timeoutMs); })])
    .finally(() => clearTimeout(timer!));
}

const lookup: Lookup = async (hostname, options) => {
  const records = await withTimeout(dnsLookup(hostname, { all: true, verbatim: true }), options.timeoutMs);
  return records.map(record => record.address);
};

const request: Request = (url, options) => new Promise((resolve, reject) => {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const requestOptions: HttpsRequestOptions = {
    protocol: 'https:', hostname, port: url.port || 443, path: `${url.pathname}${url.search}`, method: options.method,
    headers: options.headers, rejectUnauthorized: options.rejectUnauthorized, servername: options.servername, agent: false, ca: options.ca,
    lookup: (_host: string, lookupOptions: LookupOptions, callback) => {
      const address = { address: options.address, family: isIP(options.address) };
      if (lookupOptions.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    },
  };
  const req = httpsRequest(requestOptions, response => {
    const chunks: Buffer[] = [];
    let size = 0;
    const contentLength = Number(response.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      reject(new CheckFailure('response_invalid'));
      req.destroy();
      return;
    }
    response.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > options.maxBytes) { reject(new CheckFailure('response_invalid')); req.destroy(); return; }
      chunks.push(bytes);
    });
    response.on('end', () => {
      const headers = Object.fromEntries(Object.entries(response.headers).flatMap(([name, value]) => value === undefined ? [] : [[name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)]]));
      resolve({ statusCode: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
    });
    response.on('error', reject);
  });
  const requestTimer = setTimeout(() => req.destroy(new CheckFailure('request_timeout')), options.timeoutMs);
  let connectTimer: NodeJS.Timeout | undefined;
  const onAbort = () => req.destroy(new Error('provider_request_aborted'));
  req.on('socket', socket => {
    if (!socket.connecting) return;
    connectTimer = setTimeout(() => req.destroy(new CheckFailure('request_timeout')), options.connectTimeoutMs);
    socket.once('secureConnect', () => clearTimeout(connectTimer));
    socket.once('error', () => clearTimeout(connectTimer));
  });
  req.once('close', () => {
    clearTimeout(requestTimer);
    if (connectTimer) clearTimeout(connectTimer);
    options.signal?.removeEventListener('abort', onAbort);
  });
  req.once('error', reject);
  if (options.signal?.aborted) req.destroy(new Error('provider_request_aborted'));
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  req.end(options.body);
});

async function pinnedAddress(url: URL, policy: OutboundPolicy, resolve: Lookup, timeout: () => number) {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('invalid_configuration');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = [...new Set(await withTimeout(resolve(hostname, { timeoutMs: Math.min(dnsTimeoutMs, timeout()) }), timeout()))];
  if (!addresses.length || addresses.some(address => !isIP(address))) fail('provider_unavailable');
  const policyRule = policy.origins.find(rule => rule.origin === url.origin);
  if (policyRule) {
    const allowed = new Set(policyRule.addresses);
    if (addresses.length !== allowed.size || addresses.some(address => !allowed.has(address))) fail('provider_unavailable');
  } else if (addresses.some(address => !isPublicAddress(address))) fail('provider_unavailable');
  return { hostname, address: addresses[0] };
}

function requestBody(body: BodyInit | null | undefined) {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('request_body_unsupported');
}

export function createPinnedFetch(options: { policy: OutboundPolicy; lookup?: Lookup; request?: Request; ca?: { origin: string; certificate: string | Buffer }; maxBytes?: number }): typeof fetch {
  const maximum = options.maxBytes ?? responseBudget;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 7_000_000) throw new Error('invalid_configuration');
  const resolve = options.lookup ?? lookup;
  const send = options.request ?? request;
  return async (input, init) => {
    try {
      const source = input instanceof Request ? input : undefined;
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input);
      if ((init?.redirect ?? 'manual') !== 'manual') fail('invalid_configuration');
      const method = (init?.method ?? source?.method ?? 'GET').toUpperCase();
      const headers = new Headers(source?.headers);
      new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
      const requestHeaders = Object.fromEntries(headers.entries());
      const signal = init?.signal ?? source?.signal;
      const rawBody = init && 'body' in init ? init.body : source?.body ? new Uint8Array(await source.arrayBuffer()) : null;
      const body = requestBody(rawBody);
      if ((body?.byteLength ?? 0) > 64 * 1024) fail('response_invalid');
      const deadline = Date.now() + workflowTimeoutMs;
      const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) fail('request_timeout');
        return value;
      };
      const pinned = await pinnedAddress(url, options.policy, resolve, remaining);
      const response = await withTimeout(send(url, {
        ...pinned, servername: pinned.hostname, rejectUnauthorized: true, redirect: 'manual',
        ca: options.ca?.origin === url.origin ? options.ca.certificate : undefined,
        connectTimeoutMs: Math.min(connectTimeoutMs, remaining()), timeoutMs: Math.min(requestTimeoutMs, remaining()),
        maxBytes: maximum, method, headers: requestHeaders, body, signal,
      }), remaining());
      if (response.body.byteLength > maximum) fail('response_invalid');
      const responseHeaders = new Headers();
      Object.entries(response.headers).forEach(([name, value]) => responseHeaders.set(name, value));
      const responseBody = response.statusCode === 204 || response.statusCode === 304 ? null : Buffer.from(response.body);
      return new Response(responseBody, { status: response.statusCode, statusText: response.statusText, headers: responseHeaders });
    } catch (error) {
      throw new TypeError(error instanceof CheckFailure ? error.checkCode : 'provider_unavailable');
    }
  };
}

function responseJson(response: ProviderResponse, budget: number) {
  if (response.statusCode < 200 || response.statusCode >= 300) fail(response.statusCode === 429 ? 'rate_limited' : 'provider_unavailable');
  if (response.body.byteLength > budget || response.body.byteLength > responseBudget) fail('response_invalid');
  const contentType = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) fail('response_invalid');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    if (parseDocument(text, { uniqueKeys: true }).errors.length) fail('response_invalid');
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    fail('response_invalid');
  }
}

function endpoint(value: unknown) {
  if (typeof value !== 'string') fail('response_invalid');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('response_invalid');
    return url;
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    fail('response_invalid');
  }
}

function discoveryDocument(value: unknown, issuer: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('response_invalid');
  const document = value as Record<string, unknown>;
  if (document.issuer !== issuer || !Array.isArray(document.response_types_supported) || !document.response_types_supported.includes('code') ||
      !Array.isArray(document.subject_types_supported) || !document.subject_types_supported.includes('public') ||
      !Array.isArray(document.id_token_signing_alg_values_supported) || !document.id_token_signing_alg_values_supported.includes('RS256') ||
      !Array.isArray(document.token_endpoint_auth_methods_supported) || !document.token_endpoint_auth_methods_supported.some(method => ['client_secret_basic', 'client_secret_post'].includes(String(method))) ||
      !Array.isArray(document.code_challenge_methods_supported) || !document.code_challenge_methods_supported.includes('S256')) fail('response_invalid');
  return {
    authorization: endpoint(document.authorization_endpoint), token: endpoint(document.token_endpoint), jwks: endpoint(document.jwks_uri),
  };
}

function verifyJwks(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { keys?: unknown }).keys)) fail('response_invalid');
  const keys = (value as { keys: unknown[] }).keys;
  if (!keys.length || keys.length > maxJwksKeys) fail('response_invalid');
  for (const item of keys) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = item as Record<string, unknown>;
    if (key.kty !== 'RSA' || key.use === 'enc' || (key.alg !== undefined && key.alg !== 'RS256') || typeof key.kid !== 'string' || !key.kid) continue;
    try {
      const parsed = createPublicKey({ key, format: 'jwk' });
      if ((parsed.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) return;
    } catch { continue; }
  }
  fail('response_invalid');
}

function validPem(value: string | null | undefined) {
  if (!value) fail('invalid_configuration');
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail('invalid_configuration');
    return key;
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    fail('invalid_configuration');
  }
}

function githubToken(candidate: Candidate, credentials: Credentials) {
  const appId = Number(candidate.github.appId);
  if (!Number.isSafeInteger(appId) || appId < 1) fail('invalid_configuration');
  const key = validPem(credentials.githubPrivateKey);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString('base64url');
  const content = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(content);
  return `${content}.${signer.sign(key).toString('base64url')}`;
}

export function createProviderCheckRunner(options: {
  policy: OutboundPolicy;
  githubApiOrigin?: string;
  ca?: { origin: string; certificate: string | Buffer };
  lookup?: Lookup;
  request?: Request;
  ownerLogin?: () => Promise<void>;
}) {
  const githubApiOrigin = options.githubApiOrigin ?? 'https://api.github.com';
  if (!validOriginValue(githubApiOrigin) || (options.githubApiOrigin && new URL(githubApiOrigin).hostname !== 'localhost')) throw new Error('invalid_configuration');
  const resolve = options.lookup ?? lookup;
  const send = options.request ?? request;
  let inProgress = false;

  return {
    async run(type: CheckType, candidate: Candidate, credentials: Credentials) {
      if (inProgress) return { type, candidateVersion: candidate.version, status: 'failed' as const, code: 'rate_limited' as const };
      inProgress = true;
      const deadline = Date.now() + workflowTimeoutMs;
      let bytesRead = 0;
      const remaining = () => {
        const value = deadline - Date.now();
        if (value <= 0) fail('request_timeout');
        return value;
      };
      async function json(url: URL, method: 'GET' = 'GET', headers: Record<string, string> = {}) {
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('invalid_configuration');
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const budget = responseBudget - bytesRead;
        if (budget <= 0) fail('response_invalid');
        const addresses = [...new Set(await withTimeout(resolve(hostname, { timeoutMs: Math.min(dnsTimeoutMs, remaining()) }), remaining()))];
        if (!addresses.length || addresses.some(address => !isIP(address))) fail('provider_unavailable');
        const policyRule = options.policy.origins.find(rule => rule.origin === url.origin);
        if (policyRule) {
          const allowed = new Set(policyRule.addresses);
          if (addresses.length !== allowed.size || addresses.some(address => !allowed.has(address))) fail('provider_unavailable');
        } else if (addresses.some(address => !isPublicAddress(address))) fail('provider_unavailable');
        const result = await withTimeout(send(url, {
          address: addresses[0], servername: hostname, rejectUnauthorized: true, redirect: 'manual',
          connectTimeoutMs: Math.min(connectTimeoutMs, remaining()), timeoutMs: Math.min(requestTimeoutMs, remaining()),
          ca: options.ca?.origin === url.origin ? options.ca.certificate : undefined,
          maxBytes: budget, method, headers,
        }), remaining());
        bytesRead += result.body.byteLength;
        return responseJson(result, budget);
      }

      try {
        if (type === 'zitadel_discovery') {
          if (!candidate.zitadel.issuer || !validOriginValue(candidate.zitadel.issuer)) fail('invalid_configuration');
          const issuer = candidate.zitadel.issuer;
          const metadata = await json(new URL('/.well-known/openid-configuration', issuer));
          const endpoints = discoveryDocument(metadata, issuer);
          verifyJwks(await json(endpoints.jwks));
          return { type, candidateVersion: candidate.version, status: 'passed' as const, code: 'provider_ok' as const };
        }
        if (type === 'zitadel_owner_login') {
          if (!candidate.zitadel.clientId || !candidate.zitadel.projectId || !credentials.zitadelClientSecret || !options.ownerLogin) fail('invalid_configuration');
          try { await withTimeout(options.ownerLogin(), remaining()); }
          catch (error) { if (error instanceof CheckFailure) throw error; fail('authentication_failed'); }
          return { type, candidateVersion: candidate.version, status: 'passed' as const, code: 'provider_ok' as const };
        }
        if (type === 'github_webhook') return { type, candidateVersion: candidate.version, status: 'warning' as const, code: 'delivery_unverified' as const };
        if (type === 'github_structure') {
          validPem(credentials.githubPrivateKey);
          return { type, candidateVersion: candidate.version, status: 'passed' as const, code: 'provider_ok' as const };
        }
        if (type === 'github_authentication' || type === 'github_permissions' || type === 'github_installation') {
          const token = githubToken(candidate, credentials);
          const base = new URL(githubApiOrigin);
          const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'Librarian', 'X-GitHub-Api-Version': '2022-11-28' };
          if (type === 'github_installation') {
            const installations = await json(new URL('/app/installations', base), 'GET', headers);
            if (!Array.isArray(installations)) fail('response_invalid');
            return installations.length ? { type, candidateVersion: candidate.version, status: 'passed' as const, code: 'provider_ok' as const }
              : { type, candidateVersion: candidate.version, status: 'warning' as const, code: 'installation_missing' as const };
          }
          const app = await json(new URL('/app', base), 'GET', headers);
          if (type === 'github_authentication') return { type, candidateVersion: candidate.version, status: 'passed' as const, code: 'provider_ok' as const };
          if (!app || typeof app !== 'object' || Array.isArray(app)) fail('response_invalid');
          const permissions = (app as { permissions?: unknown }).permissions;
          if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) fail('response_invalid');
          const values = Object.values(permissions as Record<string, unknown>);
          if ((permissions as Record<string, unknown>).contents !== 'read' || (permissions as Record<string, unknown>).metadata !== 'read' ||
              values.some(value => value !== 'read' && value !== 'none')) fail('permission_denied');
          return { type, candidateVersion: candidate.version, status: 'passed' as const, code: 'provider_ok' as const };
        }
        fail('invalid_configuration');
      } catch (error) {
        const code = error instanceof CheckFailure ? error.checkCode
          : error instanceof Error && error.message === 'request_timeout' ? 'request_timeout'
            : 'provider_unavailable';
        return { type, candidateVersion: candidate.version, status: 'failed' as const, code };
      } finally { inProgress = false; }
    },
  };
}

function validOriginValue(value: string) {
  try { const url = new URL(value); return value === url.origin && url.protocol === 'https:'; }
  catch { return false; }
}
