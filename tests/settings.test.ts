import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSettings, validateSessionKey } from '../electron/settings.js';

test('rejects nonlocal or credential-bearing gateway URLs before credentials are sent', () => {
  for (const url of ['ws://example.com:18789', 'https://localhost', 'ws://name:secret@localhost:18789', 'ws://localhost:18789/#token', 'ws://127.0.0.1:18789/?token=secret']) {
    assert.throws(() => validateSettings({url, distro:'Ubuntu-24.04'}), /地址|本机/);
  }
});
test('normalizes permitted loopback endpoints and distro without enabling shell arguments', () => {
  assert.equal(validateSettings({url:' ws://127.0.0.1:18789/ ',distro:' Ubuntu-24.04 '}).url, 'ws://127.0.0.1:18789/');
  assert.equal(validateSettings({url:'ws://[::1]:18789',distro:'Ubuntu-24.04'}).distro, 'Ubuntu-24.04');
  for (const distro of ['', '-e', 'Ubuntu\n--exec', 'Ubuntu; echo test']) assert.throws(() => validateSettings({url:'ws://localhost:18789',distro}), /发行版/);
});
test('rejects malformed renderer inputs and oversized credentials', () => {
  assert.throws(() => validateSettings(null as never));
  assert.throws(() => validateSettings({url:'ws://localhost:18789',distro:'Ubuntu',token:'x'.repeat(17000)}), /凭据/);
  assert.throws(() => validateSessionKey(undefined), /会话/);
  assert.throws(() => validateSessionKey(''), /会话/);
  assert.equal(validateSessionKey('agent:main:kuro-abc'), 'agent:main:kuro-abc');
});
