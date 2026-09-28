import assert from 'node:assert/strict';
import test from 'node:test';
import { listSkills } from '../electron/skills.js';

test('skill listing reports unmet requirements without forwarding configuration or secrets', async () => {
  const result = await listSkills(async (method, params) => {
    assert.equal(method, 'skills.status');
    assert.deepEqual(params, { agentId: 'main' });
    return { skills: [{ name: 'example', description: 'Example skill', source: 'workspace',
      eligible: false, disabled: false, missing: { bins: ['uv'], anyBins: ['node', 'bun'], env: ['SERVICE_KEY'], config: ['channels.demo'], os: ['darwin'] },
      apiKey: 'must-not-cross', homepage: 'https://example.org' }] };
  });
  assert.equal(result[0].name, 'example');
  assert.equal(result[0].eligible, false);
  assert.ok(result[0].missing.some(item => item.includes('uv')));
  assert.ok(result[0].missing.some(item => item.includes('SERVICE_KEY')));
  assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
});

test('skill listing rejects unsupported responses instead of reporting a misleading empty list', async () => {
  await assert.rejects(listSkills(async () => ({ items: [] })), /格式/);
  await assert.rejects(listSkills(async () => ({ skills: [null] })), /格式/);
  assert.deepEqual(await listSkills(async () => ({ skills: [] })), []);
});
