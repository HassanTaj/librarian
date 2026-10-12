import { expect, it } from 'vitest';
import { decryptOAuthToken, encryptAccountTokens, encryptOAuthToken } from '../../lib/auth/tokens';

const key = Buffer.alloc(32, 7);

it('encrypts OAuth tokens with authenticated encryption and rejects tampering', () => {
  const encrypted = encryptOAuthToken('synthetic-token', key);
  expect(encrypted).not.toContain('synthetic-token');
  expect(decryptOAuthToken(encrypted, key)).toBe('synthetic-token');
  const [iv, tag, body] = encrypted.split('.');
  const tampered = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
  expect(() => decryptOAuthToken(`${iv}.${tag}.${tampered}`, key)).toThrow('oauth_token_invalid');
  expect(() => decryptOAuthToken(encrypted, Buffer.alloc(16))).toThrow('oauth_token_invalid');
});

it('stores only string token values and excludes absent OAuth tokens', () => {
  const stored = encryptAccountTokens({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: 3600 }, key);
  expect(Object.keys(stored).sort()).toEqual(['access_token', 'refresh_token']);
  expect(JSON.stringify(stored)).not.toContain('secret');
  expect(() => encryptAccountTokens({ access_token: 42 }, key)).toThrow('oauth_token_invalid');
});
