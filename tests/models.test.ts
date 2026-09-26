import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModelManager } from '../electron/models.js';

function fixture() {
  const calls: { method: string; params: any }[] = [];
  const snapshot = { hash: 'hash-v1', valid: true, config: {
    agents: { defaults: { model: { primary: 'acme/old', fallbacks: ['other/backup'] }, models: { 'acme/old': { alias: 'Old' } } } },
    models: { providers: { acme: { baseUrl: 'https://api.example.com/v1', api: 'openai-completions', apiKey: '__OPENCLAW_REDACTED__', headers: { 'X-Tenant': 'kept' }, models: [{ id: 'old', name: 'Old', contextWindow: 12345 }, { id: 'untouched', name: 'Untouched' }] } } }
  } };
  const manager = createModelManager(async <T>(method: string, params: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === 'config.get') return snapshot as T;
    if (method === 'models.list') return { models: [{ id: 'old', name: 'Old', provider: 'acme', secret: 'not public' }] } as T;
    return { ok: true } as T;
  });
  return { calls, snapshot, manager };
}

test('lists canonical provider/model IDs and exposes only public model and config fields', async () => {
  const { manager } = fixture();
  assert.deepEqual(await manager.listModels(), [{ id: 'acme/old', name: 'Old', provider: 'acme' }]);
  assert.deepEqual(await manager.getModelSettings(), { hash: 'hash-v1', defaultModel: 'acme/old', providers: [{ id: 'acme', baseUrl: 'https://api.example.com/v1', api: 'openai-completions', hasApiKey: true, models: [{ id: 'old', name: 'Old' }, { id: 'untouched', name: 'Untouched' }] }] });
});

test('provider save preserves existing model metadata, other models and default fallback/allowlist entries', async () => {
  const { manager, calls, snapshot } = fixture();
  await manager.saveModelSettings({ hash: 'hash-v1', defaultModel: 'acme/new', provider: { id: 'acme', baseUrl: 'https://new.example.com/v1', api: 'openai-completions', apiKey: '', models: [{ id: 'old', name: 'Renamed' }, { id: 'new', name: 'New' }] } });
  const call = calls.find(call => call.method === 'config.patch')!;
  assert.equal(call.params.baseHash, 'hash-v1');
  const patch = JSON.parse(call.params.raw);
  assert.deepEqual(patch.agents.defaults.model, { primary: 'acme/new' });
  assert.deepEqual(patch.agents.defaults.models, { 'acme/new': {} });
  assert.deepEqual(patch.models.providers.acme.models, [{ id: 'old', name: 'Renamed', contextWindow: 12345 }, { id: 'untouched', name: 'Untouched' }, { id: 'new', name: 'New' }]);
  assert.equal(patch.models.providers.acme.apiKey, undefined);
  assert.equal(patch.models.providers.acme.headers, undefined);
  assert.equal(snapshot.config.models.providers.acme.models[0].name, 'Old');
});

test('stale config hashes and malformed provider inputs cannot reach a config write', async () => {
  const { manager, calls } = fixture();
  await assert.rejects(manager.saveModelSettings({ hash: 'stale', defaultModel: 'acme/new' }), /变更|刷新/);
  for (const provider of [
    { id: '__proto__', baseUrl: 'https://example.com', api: 'openai-completions', models: [] },
    { id: 'acme', baseUrl: 'https://name:password@example.com', api: 'openai-completions', models: [] },
    { id: 'acme', baseUrl: 'https://example.com', api: 'nonsense', models: [] },
  ]) await assert.rejects(manager.saveModelSettings({ hash: 'hash-v1', provider }));
  assert.equal(calls.some(call => call.method === 'config.patch'), false);
});

test('saving a new default leaves an existing allowlist entry intact and allows new model when restricted', async () => {
  const { manager, calls } = fixture();
  await manager.saveModelSettings({ hash: 'hash-v1', defaultModel: 'acme/old' });
  const patch = JSON.parse(calls.find(call => call.method === 'config.patch')!.params.raw);
  assert.equal(patch.agents.defaults.models, undefined);
});

test('switch validates session/model and restores default using null without a chat message', async () => {
  const { manager, calls } = fixture();
  await manager.switchSessionModel({ sessionKey: 'agent:main:kuro-1', model: null });
  assert.deepEqual(calls, [{ method: 'sessions.patch', params: { key: 'agent:main:kuro-1', model: null } }]);
  await assert.rejects(manager.switchSessionModel({ sessionKey: '', model: 'acme/old' }));
  await assert.rejects(manager.switchSessionModel({ sessionKey: 'agent:main:x', model: '' }));
  assert.equal(calls.length, 1);
});

test('new provider keys are not returned when gateway save fails', async () => {
  const { snapshot } = fixture();
  const manager = createModelManager(async <T>(method: string): Promise<T> => {
    if (method === 'config.get') return snapshot as T;
    throw new Error('provider rejected secret-new-123');
  });
  await assert.rejects(manager.saveModelSettings({ hash: 'hash-v1', provider: { id: 'acme', baseUrl: 'https://api.example.com', api: 'openai-completions', apiKey: 'secret-new-123', models: [{ id: 'old', name: 'Old' }] } }), error => error instanceof Error && !error.message.includes('secret-new-123'));
});

test('malformed mutation responses cannot report a successful save or model switch', async () => {
  const { snapshot } = fixture();
  for (const result of [undefined, {}, { ok: false }]) {
    const manager = createModelManager(async <T>(method: string): Promise<T> => (method === 'config.get' ? snapshot : result) as T);
    await assert.rejects(manager.saveModelSettings({ hash: 'hash-v1', defaultModel: 'acme/old' }));
    await assert.rejects(manager.switchSessionModel({ sessionKey: 'agent:main:kuro-1', model: 'acme/old' }));
  }
});

test('existing provider URLs omit embedded credentials, queries and fragments before reaching the UI', async () => {
  const { snapshot } = fixture();
  snapshot.config.models.providers.acme.baseUrl = 'https://user:secret@example.com/v1?api_key=secret#secret';
  const manager = createModelManager(async <T>(): Promise<T> => snapshot as T);
  assert.equal((await manager.getModelSettings()).providers[0].baseUrl, 'https://example.com/v1');
  snapshot.config.models.providers.acme.baseUrl = 'not-a-url-secret';
  assert.equal((await manager.getModelSettings()).providers[0].baseUrl, '');
});
