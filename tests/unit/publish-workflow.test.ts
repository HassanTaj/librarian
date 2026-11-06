import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const workflow = parse(readFileSync('.github/workflows/publish-librarian.yml', 'utf8'));
const script = workflow.jobs.publish.steps.find((step: { name: string }) => step.name === 'Validate registry configuration').run;
const bash = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../..', 'bin/bash.exe') : 'bash';

function validate(overrides: Record<string, string>) {
  const result = spawnSync(bash, ['-c', script], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, REGISTRY_HOST: 'registry.example.test:5000', REGISTRY_NAMESPACE: 'perspective-v', IMAGE_NAME: 'librarian', ...overrides } });
  if (result.error) throw result.error;
  return result;
}

it.each(['librarian', 'a', 'some__image', 'a---b', 'a.b_c'])('accepts Docker image component %s', component => {
  expect(validate({ REGISTRY_NAMESPACE: component, IMAGE_NAME: component }).status).toBe(0);
});

for (const field of ['REGISTRY_NAMESPACE', 'IMAGE_NAME']) {
  it.each(['Librarian', '.name', 'name.', 'a..b', 'a___b', 'name/name', 'name:tag', 'name@digest', 'name?', '-name', '', 'a b'])
    (`rejects invalid ${field} component %s before registry login`, component => {
      const result = validate({ [field]: component });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error::');
    });
}

it.each(['', 'https://registry.example.test', 'registry.example.test/path', 'user@registry.example.test', 'registry .example.test'])
  ('rejects invalid registry host %s', host => {
    expect(validate({ REGISTRY_HOST: host }).status).toBe(1);
  });
