import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubSignature(rawBody: Uint8Array, signature: string | null, secret: string) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature ?? '');
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(match[1], 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
