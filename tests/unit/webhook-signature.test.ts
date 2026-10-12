import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyGitHubSignature } from '../../lib/sync/webhook';

const secret = 'synthetic-webhook-signing-secret-with-sufficient-entropy';
const bytes = Buffer.from('{"ref":"refs/heads/main"}', 'utf8');
const signature = `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

it('verifies the exact original bytes and rejects changed bytes', () => {
  expect(verifyGitHubSignature(bytes, signature, secret)).toBe(true);
  expect(verifyGitHubSignature(Buffer.from(`${bytes.toString()} `), signature, secret)).toBe(false);
});

it.each([null, '', 'sha1=bad', 'sha256=abc', `sha256=${'z'.repeat(64)}`, `sha256=${'a'.repeat(65)}`])
  ('rejects malformed or missing signature %s', value => {
    expect(verifyGitHubSignature(bytes, value, secret)).toBe(false);
  });
