import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let browser: Browser;
let base: string;
before(async () => {
  server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 5189, strictPort: false } });
  await server.listen();
  base = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function openWorkspace(): Promise<Page> {
  // Vite's development refresh preamble is inline; production CSP is exercised by Electron smoke.
  const page = await browser.newPage({ viewport: { width: 944, height: 641 }, bypassCSP: true });
  page.on('pageerror', error => console.error('UI test page error:', error.message));
  // tsx names serialized fixture functions through this helper.
  await page.addInitScript('globalThis.__name = (value) => value;');
  await page.addInitScript(() => {
    const statusListeners = new Set<(status: any) => void>();
    const eventListeners = new Set<(event: any) => void>();
    const fixture: any = {
      config: { url: 'ws://127.0.0.1:18789/', distro: 'Ubuntu-24.04', hasCredential: false, credentialSource: 'none' },
      status: { state: 'connected', endpoint: 'ws://127.0.0.1:18789/' },
      saved: undefined, deferHistory: false, deferList: false,
      emit(status: any) { fixture.status = status; statusListeners.forEach(fn => fn(status)); },
      emitChat(payload: any) { eventListeners.forEach(fn => fn({ event: 'chat', payload })); },
    };
    (window as any).fixture = fixture;
    (window as any).kuro = {
      getSettings: async () => ({ ...fixture.config }), getStatus: async () => fixture.status,
      onStatus: (fn: any) => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
      onEvent: (fn: any) => { eventListeners.add(fn); return () => eventListeners.delete(fn); },
      listSessions: async () => {
        const side = fixture.config.url.includes('19999') ? 'B' : 'A';
        const result = [{ key: 'agent:main:main', displayName: `Shared ${side}` }];
        if (fixture.deferList && side === 'A') return new Promise(resolve => { fixture.resolveList = () => resolve([...result, { key: 'old', displayName: 'Old endpoint list' }]); });
        return result;
      },
      history: async () => {
        const side = fixture.config.url.includes('19999') ? 'B' : 'A';
        const result = { messages: [{ role: 'assistant', content: `Gateway ${side} history` }] };
        if (fixture.deferHistory && side === 'A') return new Promise(resolve => { fixture.resolveHistory = () => resolve(result); });
        return result;
      },
      saveSettings: async (input: any) => {
        fixture.saved = input;
        fixture.config = { url: input.url, distro: input.distro, hasCredential: !!(input.token || input.password), credentialSource: input.token || input.password ? 'manual' : 'none' };
        fixture.emit({ state: 'disconnected', endpoint: fixture.status.endpoint });
        return { ...fixture.config };
      },
      importWsl: async () => { fixture.config = { ...fixture.config, url: 'ws://127.0.0.1:19999/', hasCredential: true, credentialSource: 'wsl' }; fixture.emit({ state: 'disconnected', endpoint: fixture.status.endpoint }); return { ...fixture.config }; },
      connect: async () => { const next = { state: 'connected', endpoint: fixture.config.url }; fixture.emit(next); return next; },
      disconnect: async () => fixture.emit({ state: 'disconnected', endpoint: fixture.config.url }),
      send: async () => new Promise(resolve => { fixture.resolveSend = () => resolve({ runId: 'old-run-id' }); }),
      abort: async () => ({ aborted: true }), openExternal: async () => {},
    };
  });
  await page.goto(base);
  await page.locator('.session-item').filter({ hasText: 'Shared A' }).waitFor();
  return page;
}

test('final sharing the last delta sequence clears writing indicators and allows the next message', async () => {
  const page = await openWorkspace();
  try {
    await page.evaluate(() => {
      const f = (window as any).fixture;
      window.kuro.send = async input => { f.sessionKey = input.sessionKey; f.runId = input.idempotencyKey; return { runId: input.idempotencyKey }; };
      window.kuro.history = async () => ({ messages: [{ role: 'assistant', content: '这条回复已经完整结束。' }] });
    });
    await page.getByRole('textbox', { name: '发送给库洛的消息' }).fill('请回复');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(() => !!(window as any).fixture.runId);
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.emitChat({ sessionKey: f.sessionKey, runId: f.runId, seq: 7, state: 'delta', message: { role: 'assistant', content: '这条回复已经完整结束。' } });
    });
    await page.locator('.run-activity').filter({ hasText: '库洛正在写下回复' }).waitFor();
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.emitChat({ sessionKey: f.sessionKey, runId: f.runId, seq: 7, state: 'final', message: { role: 'assistant', content: '这条回复已经完整结束。' } });
    });
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 3000 });
    assert.equal(await page.locator('.run-activity').count(), 0);
    assert.equal(await page.locator('.companion-footer p').innerText(), '我在这里，慢慢说就好。');
    assert.equal(await page.getByRole('button', { name: '停止回复', exact: true }).count(), 0);
    await page.getByRole('textbox', { name: '发送给库洛的消息' }).fill('下一条');
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true);
  } finally { await page.close(); }
});

test('manual password preserves whitespace, sends password without token, and clears on save', async () => {
  const page = await openWorkspace();
  try {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('#gateway-token').fill('discard-this-token');
    assert.equal(await page.locator('#credential-kind').count(), 1, 'Settings needs a credential type selector');
    await page.locator('#credential-kind').selectOption('password');
    await page.locator('#gateway-password').fill('  password with spaces  ');
    await page.locator('.settings-footer .primary-button').click();
    await page.waitForFunction(() => !!(window as any).fixture.saved);
    const saved = await page.evaluate(() => (window as any).fixture.saved);
    assert.equal(saved.password, '  password with spaces  ');
    assert.equal('token' in saved, false);
    assert.equal(await page.locator('#gateway-password').inputValue(), '');
    assert.equal(await page.locator('#gateway-password').getAttribute('type'), 'password');
  } finally { await page.close(); }
});

test('automatic import refreshes public settings after a connection transition', async () => {
  const page = await openWorkspace();
  try {
    await page.evaluate(() => { const f = (window as any).fixture; f.config = { ...f.config, distro: 'Debian', hasCredential: true, credentialSource: 'wsl' }; f.emit({ state: 'connecting', endpoint: f.config.url }); f.emit({ state: 'connected', endpoint: f.config.url }); });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#wsl-distro').inputValue(), 'Debian');
  } finally { await page.close(); }
});

test('endpoint replacement invalidates loaded chats, local sessions, and deferred old history/list reads', async () => {
  const page = await openWorkspace();
  try {
    await page.locator('.session-item').filter({ hasText: 'Shared A' }).click();
    await page.getByText('Gateway A history', { exact: true }).waitFor();
    await page.evaluate(() => { (window as any).fixture.deferHistory = true; (window as any).fixture.deferList = true; });
    await page.locator('.header-actions .icon-button').click();
    await page.locator('.section-label .icon-button').click();
    await page.waitForFunction(() => !!(window as any).fixture.resolveHistory && !!(window as any).fixture.resolveList);
    await page.locator('.new-chat').click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('#gateway-url').fill('ws://127.0.0.1:19999/');
    await page.locator('.settings-footer .primary-button').click();
    await page.waitForFunction(() => (window as any).fixture.saved?.url.includes('19999'));
    await page.getByRole('button', { name: '网关', exact: true }).click();
    await page.locator('.card-actions .primary-button').click();
    await page.locator('.session-item').filter({ hasText: 'Shared B' }).click();
    await page.evaluate(() => { (window as any).fixture.resolveHistory(); (window as any).fixture.resolveList(); });
    await page.waitForTimeout(100);
    assert.match(await page.locator('.messages').innerText(), /Gateway B history/);
    assert.doesNotMatch(await page.locator('.workspace').innerText(), /Gateway A history/);
    assert.equal(await page.locator('.session-item').count(), 1, 'old local and deferred remote sessions must be discarded');
  } finally { await page.close(); }
});

test('minimum Electron content size keeps composer, send button and rail footer inside viewport', async () => {
  const page = await openWorkspace();
  try {
    for (const selector of ['.send-button', '.composer-footer', '.rail-bottom']) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 641, `${selector} must remain fully visible`);
    }
  } finally { await page.close(); }
});

async function startStoppableReply(page: Page, options: { pending?: boolean; idle?: boolean; historyFailure?: boolean; unconfirmed?: boolean } = {}) {
  await page.evaluate(options => {
    const f = (window as any).fixture;
    f.abortCalls = [];
    window.kuro.send = async input => {
      f.sessionKey = input.sessionKey;
      if (options.pending) return new Promise(resolve => { f.resolveSend = () => resolve({ runId: 'gateway-run' }); });
      return { runId: 'gateway-run' };
    };
    window.kuro.abort = async input => {
      f.abortCalls.push(input);
      if (options.unconfirmed) return { ok: true };
      if (input.runId || options.idle) return { ok: true, aborted: false, runIds: [] };
      return { ok: true, aborted: true, runIds: ['actual-run'] };
    };
    window.kuro.history = async () => {
      if (options.historyFailure) throw new Error('history unavailable');
      return { messages: [{ role: 'assistant', content: 'Authoritative stopped history' }] };
    };
  }, options);
  await page.locator('textarea').fill('Please keep replying');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor();
}

test('Stop falls back to the same session when the gateway no longer recognizes the run ID', async () => {
  const page = await openWorkspace();
  try {
    await startStoppableReply(page);
    await page.getByRole('button', { name: '停止回复', exact: true }).click();
    await page.waitForFunction(() => (window as any).fixture.abortCalls.length === 2, {}, { timeout: 2000 });
    const { abortCalls, sessionKey } = await page.evaluate(() => (window as any).fixture);
    assert.deepEqual(abortCalls, [{ sessionKey, runId: 'gateway-run' }, { sessionKey }]);
    await page.getByText('Authoritative stopped history', { exact: true }).waitFor();
    assert.equal(await page.locator('.stop-button').count(), 0);
  } finally { await page.close(); }
});

test('Stop reconciles an already idle session instead of waiting forever for a terminal event', async () => {
  const page = await openWorkspace();
  try {
    await startStoppableReply(page, { idle: true });
    await page.getByRole('button', { name: '停止回复', exact: true }).click();
    await page.getByText('Authoritative stopped history', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('.stop-button').count(), 0);
    await page.locator('textarea').fill('Next message');
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true);
  } finally { await page.close(); }
});

test('Stop requested before send acknowledgment waits for the real run ID', async () => {
  const page = await openWorkspace();
  try {
    await startStoppableReply(page, { pending: true });
    await page.getByRole('button', { name: '停止回复', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.abortCalls), []);
    await page.evaluate(() => (window as any).fixture.resolveSend());
    await page.getByText('Authoritative stopped history', { exact: true }).waitFor({ timeout: 2000 });
    const calls = await page.evaluate(() => (window as any).fixture.abortCalls);
    assert.equal(calls[0].runId, 'gateway-run');
    assert.equal(await page.locator('.stop-button').count(), 0);
  } finally { await page.close(); }
});

test('confirmed Stop releases the run even if refreshing history fails', async () => {
  const page = await openWorkspace();
  try {
    await startStoppableReply(page, { historyFailure: true });
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.emitChat({ sessionKey: f.sessionKey, runId: 'gateway-run', seq: 1, state: 'delta', message: { role: 'assistant', content: 'Partial reply retained' } });
    });
    await page.evaluate(() => { window.kuro.abort = async () => ({ ok: true, aborted: true, runIds: ['gateway-run'] }); });
    await page.getByRole('button', { name: '停止回复', exact: true }).click();
    await page.getByText(/history unavailable/).waitFor();
    assert.equal(await page.locator('.stop-button').count(), 0);
    assert.match(await page.locator('.messages').innerText(), /Please keep replying/);
    assert.match(await page.locator('.messages').innerText(), /Partial reply retained/);
  } finally { await page.close(); }
});

test('Stop does not treat a malformed acknowledgment as confirmation', async () => {
  const page = await openWorkspace();
  try {
    await startStoppableReply(page, { unconfirmed: true });
    await page.getByRole('button', { name: '停止回复', exact: true }).click();
    await page.getByText(/网关尚未确认停止/).waitFor();
    assert.equal(await page.getByRole('button', { name: '停止回复', exact: true }).isEnabled(), true);
    assert.equal((await page.evaluate(() => (window as any).fixture.abortCalls)).length, 1);
  } finally { await page.close(); }
});

test('a late Stop result cannot abort a newer reply in the same session', async () => {
  const page = await openWorkspace();
  try {
    await startStoppableReply(page);
    await page.evaluate(() => {
      const f = (window as any).fixture;
      window.kuro.abort = async input => {
        f.abortCalls.push(input);
        return new Promise(resolve => { f.resolveAbort = () => resolve({ ok: true, aborted: false, runIds: [] }); });
      };
    });
    await page.getByRole('button', { name: '停止回复', exact: true }).click();
    await page.waitForFunction(() => !!(window as any).fixture.resolveAbort);
    await page.evaluate(() => {
      const f = (window as any).fixture;
      f.emitChat({ sessionKey: f.sessionKey, runId: 'gateway-run', seq: 2, state: 'final' });
    });
    await page.getByText('Authoritative stopped history', { exact: true }).waitFor();
    await page.locator('textarea').fill('New reply must continue');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('button', { name: '停止回复', exact: true }).waitFor();
    await page.evaluate(async () => {
      (window as any).fixture.resolveAbort();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.equal((await page.evaluate(() => (window as any).fixture.abortCalls)).length, 1);
    assert.equal(await page.getByRole('button', { name: '停止回复', exact: true }).isEnabled(), true);
  } finally { await page.close(); }
});

test('WSL import discards the old gateway draft and ignores its late send acknowledgment', async () => {
  const page = await openWorkspace();
  try {
    await page.locator('textarea').fill('Pending old gateway draft');
    await page.locator('textarea').press('Enter');
    await page.waitForFunction(() => !!(window as any).fixture.resolveSend);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.field-row .secondary-button').click();
    await page.waitForFunction(() => (window as any).fixture.config.url.includes('19999'));
    await page.getByRole('button', { name: '网关', exact: true }).click();
    await page.locator('.card-actions .primary-button').click();
    await page.locator('.session-item').filter({ hasText: 'Shared B' }).click();
    await page.getByText('Gateway B history', { exact: true }).waitFor();
    await page.evaluate(() => (window as any).fixture.resolveSend());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.equal(await page.locator('.run-activity').count(), 0);
    assert.equal(await page.locator('.session-item').count(), 1);
    assert.doesNotMatch(await page.locator('.workspace').innerText(), /Pending old gateway draft/);
    assert.match(await page.locator('.messages').innerText(), /Gateway B history/);
  } finally { await page.close(); }
});

test('a fresh draft written after saving the new endpoint survives its first connection', async () => {
  const page = await openWorkspace();
  try {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('#gateway-url').fill('ws://127.0.0.1:19999/');
    await page.locator('.settings-footer .primary-button').click();
    await page.waitForFunction(() => (window as any).fixture.saved?.url.includes('19999'));
    await page.getByRole('button', { name: '聊天', exact: true }).click();
    await page.locator('textarea').fill('New gateway draft');
    await page.getByRole('button', { name: '网关', exact: true }).click();
    await page.locator('.card-actions .primary-button').click();
    await page.getByRole('button', { name: '聊天', exact: true }).click();
    assert.equal(await page.locator('textarea').inputValue(), 'New gateway draft');
  } finally { await page.close(); }
});
