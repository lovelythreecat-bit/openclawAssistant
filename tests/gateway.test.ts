import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { GatewayClient } from '../electron/gateway.js';
import { createModelManager } from '../electron/models.js';
import { createIdentity, signDevice, type DeviceIdentity } from '../electron/identity.js';

type JsonRecord = Record<string, any>;

const defaultPolicy = {
  maxPayload: 256 * 1024,
  maxBufferedBytes: 256 * 1024,
  tickIntervalMs: 60_000,
};

function helloPayload(overrides: JsonRecord = {}): JsonRecord {
  return {
    type: 'hello-ok',
    protocol: 3,
    server: { version: '2026.5.3-1', connId: 'test-connection' },
    features: { methods: ['chat.send'], events: ['chat'] },
    snapshot: {},
    policy: defaultPolicy,
    ...overrides,
  };
}

async function startGateway(
  onRequest: (frame: JsonRecord, socket: WebSocket, connectionIndex: number) => void,
  options: { challenge?: boolean } = {},
) {
  const server = new WebSocketServer({ port: 0 });
  const sockets: WebSocket[] = [];
  let connectionIndex = 0;

  server.on('connection', (socket) => {
    const index = connectionIndex++;
    sockets.push(socket);
    if (options.challenge !== false) {
      socket.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: `nonce-${index}`, ts: Date.now() },
      }));
    }
    socket.on('message', (raw) => {
      onRequest(JSON.parse(raw.toString()), socket, index);
    });
  });

  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  return {
    server,
    sockets,
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function respond(socket: WebSocket, request: JsonRecord, payload: unknown): void {
  socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
}

function waitFor<T>(subscribe: (resolve: (value: T) => void) => void, timeoutMs = 1_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test wait timed out')), timeoutMs);
    subscribe((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function connectOptions(url: string, identity: DeviceIdentity, overrides: JsonRecord = {}) {
  return { url, identity, token: 'shared-secret', ...overrides };
}

test('createIdentity and signDevice produce the exact protocol-v3 Ed25519 proof', () => {
  const identity = createIdentity();
  const publicDer = createPublicKey(identity.publicKeyPem).export({ type: 'spki', format: 'der' });
  const expectedPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const rawPublicKey = publicDer.subarray(-32);

  assert.deepEqual(publicDer.subarray(0, expectedPrefix.length), expectedPrefix);
  assert.equal(identity.deviceId, createHash('sha256').update(rawPublicKey).digest('hex'));

  const signedAt = 1_789_500_000_123;
  const device = signDevice(identity, 'challenge-123', 'shared-secret', signedAt);
  assert.deepEqual(Object.keys(device).sort(), ['id', 'nonce', 'publicKey', 'signature', 'signedAt']);
  assert.equal(device.id, identity.deviceId);
  assert.equal(device.publicKey, rawPublicKey.toString('base64url'));
  assert.equal(device.signedAt, signedAt);
  assert.equal(device.nonce, 'challenge-123');

  const exactPayload = [
    'v3',
    identity.deviceId,
    'gateway-client',
    'ui',
    'operator',
    'operator.read,operator.write',
    '1789500000123',
    'shared-secret',
    'challenge-123',
    'win32',
    '',
  ].join('|');
  assert.equal(
    verify(null, Buffer.from(exactPayload, 'utf8'), identity.publicKeyPem, Buffer.from(device.signature, 'base64url')),
    true,
  );
});

test('connect sends the exact handshake, prefers the shared token, and exposes no secret in status', async (t) => {
  const identity = createIdentity();
  let connectFrame: JsonRecord | undefined;
  const gateway = await startGateway((frame, socket) => {
    connectFrame = frame;
    respond(socket, frame, helloPayload({
      auth: { deviceToken: 'issued-device-token', role: 'operator', scopes: ['operator.read'] },
    }));
  });
  const client = new GatewayClient(250);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });

  const statuses: JsonRecord[] = [];
  client.on('status', (status) => statuses.push(status));
  const deviceToken = waitFor<{ token: string; scopes: string[] }>((resolve) => {
    client.once('deviceToken', resolve);
  });
  const status = await client.connect(connectOptions(gateway.url, identity, {
    deviceToken: 'stored-device-token',
    password: 'unused-password',
  }));

  assert(connectFrame);
  assert.equal(connectFrame.type, 'req');
  assert.equal(connectFrame.method, 'connect');
  assert.deepEqual(connectFrame.params.auth, { token: 'shared-secret' });
  assert.deepEqual(connectFrame.params.client, {
    id: 'gateway-client',
    displayName: '库洛桌面',
    version: '0.1.0',
    platform: 'win32',
    mode: 'ui',
  });
  assert.deepEqual(connectFrame.params.scopes, ['operator.read', 'operator.write']);
  assert.deepEqual(connectFrame.params.caps, ['tool-events']);
  assert.equal(connectFrame.params.minProtocol, 3);
  assert.equal(connectFrame.params.maxProtocol, 3);
  assert.equal(connectFrame.params.role, 'operator');
  assert.equal(connectFrame.params.locale, 'zh-CN');
  assert.equal(connectFrame.params.userAgent, 'kuro-desktop/0.1.0');
  assert.equal(connectFrame.params.device.nonce, 'nonce-0');

  const signaturePayload = [
    'v3', identity.deviceId, 'gateway-client', 'ui', 'operator',
    'operator.read,operator.write', String(connectFrame.params.device.signedAt),
    'shared-secret', 'nonce-0', 'win32', '',
  ].join('|');
  assert.equal(verify(
    null,
    Buffer.from(signaturePayload, 'utf8'),
    identity.publicKeyPem,
    Buffer.from(connectFrame.params.device.signature, 'base64url'),
  ), true);

  assert.equal(status.state, 'connected');
  assert.equal(status.endpoint, gateway.url);
  assert.equal(status.version, '2026.5.3-1');
  assert.equal(typeof status.connectedAt, 'number');
  assert.deepEqual(await deviceToken, { token: 'issued-device-token', scopes: ['operator.read'] });
  assert.equal(JSON.stringify([status, ...statuses]).includes('shared-secret'), false);
  assert.equal(JSON.stringify([status, ...statuses]).includes('stored-device-token'), false);
  assert.equal(JSON.stringify([status, ...statuses]).includes('issued-device-token'), false);
  assert.equal(JSON.stringify([status, ...statuses]).includes('unused-password'), false);
});

test('management connection signs and requests admin permission without changing ordinary chat scopes', async (t) => {
  const identity = createIdentity();
  let connectFrame: JsonRecord | undefined;
  const gateway = await startGateway((frame, socket) => {
    if (frame.method === 'connect') {
      connectFrame = frame;
      respond(socket, frame, helloPayload());
    }
  });
  t.after(() => gateway.close());
  const client = new GatewayClient();
  t.after(() => client.disconnect());
  await client.connect({ url: gateway.url, token: 'management-token', identity, management: true });
  assert.deepEqual(connectFrame!.params.scopes, ['operator.read', 'operator.write', 'operator.admin']);
  const device = connectFrame!.params.device;
  const payload = ['v3', identity.deviceId, 'gateway-client', 'ui', 'operator',
    'operator.read,operator.write,operator.admin', String(device.signedAt), 'management-token', 'nonce-0', 'win32', ''].join('|');
  assert.equal(verify(null, Buffer.from(payload), identity.publicKeyPem, Buffer.from(device.signature, 'base64url')), true);
});

test('connect falls back to the stored device token when no shared token is supplied', async (t) => {
  const identity = createIdentity();
  let connectFrame: JsonRecord | undefined;
  const gateway = await startGateway((frame, socket) => {
    connectFrame = frame;
    respond(socket, frame, helloPayload());
  });
  const client = new GatewayClient(250);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });

  await client.connect({ url: gateway.url, identity, deviceToken: 'stored-device-token' });
  assert(connectFrame);
  assert.deepEqual(connectFrame.params.auth, { token: 'stored-device-token' });
  const payload = [
    'v3', identity.deviceId, 'gateway-client', 'ui', 'operator',
    'operator.read,operator.write', String(connectFrame.params.device.signedAt),
    'stored-device-token', 'nonce-0', 'win32', '',
  ].join('|');
  assert.equal(verify(
    null,
    Buffer.from(payload, 'utf8'),
    identity.publicKeyPem,
    Buffer.from(connectFrame.params.device.signature, 'base64url'),
  ), true);
});

test('password authentication is independent and signs with an empty token', async (t) => {
  const identity = createIdentity();
  let connectFrame: JsonRecord | undefined;
  const gateway = await startGateway((frame, socket) => {
    connectFrame = frame;
    respond(socket, frame, helloPayload());
  });
  const client = new GatewayClient(250);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });

  await client.connect({ url: gateway.url, identity, password: 'gateway-password' });
  assert(connectFrame);
  assert.deepEqual(connectFrame.params.auth, { password: 'gateway-password' });
  const payload = [
    'v3', identity.deviceId, 'gateway-client', 'ui', 'operator',
    'operator.read,operator.write', String(connectFrame.params.device.signedAt),
    '', 'nonce-0', 'win32', '',
  ].join('|');
  assert.equal(verify(
    null,
    Buffer.from(payload, 'utf8'),
    identity.publicKeyPem,
    Buffer.from(connectFrame.params.device.signature, 'base64url'),
  ), true);
});

test('request correlates out-of-order replies and keeps gateway errors useful', async (t) => {
  const held: JsonRecord[] = [];
  const gateway = await startGateway((frame, socket) => {
    if (frame.method === 'connect') {
      respond(socket, frame, helloPayload());
      return;
    }
    if (frame.method === 'fails') {
      socket.send(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'invalid filter', details: { field: 'limit' } },
      }));
      return;
    }
    held.push(frame);
    if (held.length === 2) {
      respond(socket, held[1], { value: 'second-result' });
      respond(socket, held[0], { value: 'first-result' });
    }
  });
  const client = new GatewayClient(300);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });
  await client.connect(connectOptions(gateway.url, createIdentity()));

  const first = client.request<{ value: string }>('first', { ordinal: 1 });
  const second = client.request<{ value: string }>('second', { ordinal: 2 });
  assert.deepEqual(await Promise.all([first, second]), [
    { value: 'first-result' },
    { value: 'second-result' },
  ]);
  assert.notEqual(held[0].id, held[1].id);
  await assert.rejects(client.request('fails', {}), /BAD_REQUEST.*invalid filter/i);
});

test('pairing errors explain the action and redact known credentials', async (t) => {
  const secret = 'credential-that-must-not-leak';
  const gateway = await startGateway((frame, socket) => {
    socket.send(JSON.stringify({
      type: 'res',
      id: frame.id,
      ok: false,
      error: {
        code: 'NOT_PAIRED',
        message: `token ${secret} requires pairing`,
        details: { requestId: 'pairing-request-42' },
      },
    }));
  });
  const client = new GatewayClient(250);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });

  await assert.rejects(
    client.connect(connectOptions(gateway.url, createIdentity(), { token: secret })),
    (error: Error) => {
      assert.match(error.message, /pairing-request-42/);
      assert.match(error.message, /approve|pair/i);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
  assert.equal(client.getStatus().state, 'error');
  assert.equal(JSON.stringify(client.getStatus()).includes(secret), false);
});

test('model save exposes the pending approval command and succeeds when retried after approval', { timeout: 5_000 }, async (t) => {
  const requestId = 'e5c48e71-01ab-4134-bebd-e41b8ad3f956';
  let approved = false;
  let writes = 0;
  const gateway = await startGateway((frame, socket) => {
    if (frame.method === 'connect' && !approved) {
      socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: {
        code: 'NOT_PAIRED', message: 'pairing required secret-provider-key', details: { requestId },
      } }));
    } else if (frame.method === 'connect') respond(socket, frame, helloPayload());
    else if (frame.method === 'config.patch') { writes++; respond(socket, frame, { ok: true }); }
  });
  const client = new GatewayClient();
  t.after(async () => { client.disconnect(); await gateway.close(); });
  const options = { url: gateway.url, identity: createIdentity(), token: 'shared-secret', management: true };
  const manager = createModelManager(async <T>(method: string, params: unknown): Promise<T> => {
    if (method === 'config.get') return { valid: true, hash: 'config-hash', config: {} } as T;
    if (client.getStatus().state !== 'connected') await client.connect(options);
    return client.request<T>(method, params);
  });
  const input = { hash: 'config-hash', provider: {
    id: 'acme', baseUrl: 'https://api.example.com/v1', api: 'openai-completions',
    models: [{ id: 'new', name: 'New' }],
  } };
  await assert.rejects(manager.saveModelSettings(input), (error: Error) => {
    assert.equal(error.message.includes(`openclaw devices approve ${requestId}`), true);
    assert.match(error.message, /批准.*重新保存/);
    assert.equal(error.message.includes('secret-provider-key'), false);
    return true;
  });
  assert.equal(writes, 0);
  approved = true;
  const result = await manager.saveModelSettings(input);
  assert.equal(result.restartRequired, true);
  assert.equal(writes, 1);
});

test('disconnect rejects pending work and a new generation ignores stale socket callbacks', async (t) => {
  let sawFirstConnect = false;
  const gateway = await startGateway((frame, socket, index) => {
    if (frame.method === 'connect') {
      if (index === 0) {
        sawFirstConnect = true;
        return;
      }
      respond(socket, frame, helloPayload({ server: { version: 'new-generation', connId: 'new' } }));
      return;
    }
    if (frame.method === 'never-finishes') return;
    respond(socket, frame, { ok: true });
  });
  const client = new GatewayClient(500);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });

  const firstConnect = client.connect(connectOptions(gateway.url, createIdentity()));
  const firstRejected = assert.rejects(firstConnect, /replaced|reconnect|disconnected/i);
  await waitFor<void>((resolve) => {
    const poll = setInterval(() => {
      if (sawFirstConnect) {
        clearInterval(poll);
        resolve();
      }
    }, 2);
  });
  const secondStatus = await client.connect(connectOptions(gateway.url, createIdentity()));
  await firstRejected;
  assert.equal(secondStatus.version, 'new-generation');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.getStatus().state, 'connected');
  assert.equal(client.getStatus().version, 'new-generation');

  const pending = client.request('never-finishes', {});
  client.disconnect();
  await assert.rejects(pending, /disconnected/i);
  assert.equal(client.getStatus().state, 'disconnected');
});

test('challenge, handshake, and ordinary requests each time out and release pending state', async (t) => {
  const noChallenge = await startGateway(() => undefined, { challenge: false });
  const challengeClient = new GatewayClient(40);
  t.after(async () => {
    challengeClient.disconnect();
    await noChallenge.close();
  });
  await assert.rejects(
    challengeClient.connect(connectOptions(noChallenge.url, createIdentity())),
    /challenge.*timed out/i,
  );

  const noHello = await startGateway(() => undefined);
  const handshakeClient = new GatewayClient(40);
  t.after(async () => {
    handshakeClient.disconnect();
    await noHello.close();
  });
  await assert.rejects(
    handshakeClient.connect(connectOptions(noHello.url, createIdentity())),
    /connect.*timed out/i,
  );

  const noRpc = await startGateway((frame, socket) => {
    if (frame.method === 'connect') respond(socket, frame, helloPayload());
  });
  const rpcClient = new GatewayClient(40);
  t.after(async () => {
    rpcClient.disconnect();
    await noRpc.close();
  });
  await rpcClient.connect(connectOptions(noRpc.url, createIdentity()));
  await assert.rejects(rpcClient.request('slow.method', {}), /slow\.method.*timed out/i);
  await assert.rejects(rpcClient.request('slow.method', {}), /slow\.method.*timed out/i);
});

test('server silence beyond two tick intervals disconnects with a truthful status', async (t) => {
  const gateway = await startGateway((frame, socket) => {
    respond(socket, frame, helloPayload({
      policy: { ...defaultPolicy, tickIntervalMs: 25 },
    }));
  });
  const client = new GatewayClient(250);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });
  await client.connect(connectOptions(gateway.url, createIdentity()));

  const silentStatus = await waitFor<JsonRecord>((resolve) => {
    client.on('status', (status) => {
      if (status.state === 'disconnected' && /silent/i.test(status.message ?? '')) resolve(status);
    });
  }, 750);
  assert.equal(silentStatus.endpoint, gateway.url);
  assert.equal(client.getStatus().state, 'disconnected');
});

test('outgoing policy limits are enforced before data is queued', async (t) => {
  let oversizedRequestSeen = false;
  const gateway = await startGateway((frame, socket) => {
    if (frame.method === 'connect') {
      respond(socket, frame, helloPayload({
        policy: { maxPayload: 180, maxBufferedBytes: 180, tickIntervalMs: 60_000 },
      }));
      return;
    }
    oversizedRequestSeen = true;
  });
  const client = new GatewayClient(250);
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });
  await client.connect(connectOptions(gateway.url, createIdentity()));

  await assert.rejects(
    client.request('large.request', { text: 'x'.repeat(500) }),
    /payload.*limit/i,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(oversizedRequestSeen, false);
});

test('chat.send preserves params exactly and streamed snapshots are emitted without concatenation', async (t) => {
  const snapshots: JsonRecord[] = [];
  let sentParams: unknown;
  const gateway = await startGateway((frame, socket) => {
    if (frame.method === 'connect') {
      respond(socket, frame, helloPayload());
      return;
    }
    sentParams = frame.params;
    respond(socket, frame, { runId: 'run-1', status: 'accepted' });
    socket.send(JSON.stringify({
      type: 'event', event: 'chat', seq: 1,
      payload: { sessionKey: 'agent:main:main', runId: 'run-1', seq: 1, state: 'delta', message: { role: 'assistant', content: '你' } },
    }));
    socket.send(JSON.stringify({
      type: 'event', event: 'chat', seq: 2,
      payload: { sessionKey: 'agent:main:main', runId: 'run-1', seq: 2, state: 'delta', message: { role: 'assistant', content: '你好' } },
    }));
  });
  const client = new GatewayClient(250);
  client.on('event', (event) => {
    if (event.event === 'chat') snapshots.push(event.payload as JsonRecord);
  });
  t.after(async () => {
    client.disconnect();
    await gateway.close();
  });
  await client.connect(connectOptions(gateway.url, createIdentity()));

  const params = {
    sessionKey: 'agent:main:main',
    message: '你好',
    idempotencyKey: 'idem-123',
    deliver: false,
  };
  assert.deepEqual(await client.request('chat.send', params), { runId: 'run-1', status: 'accepted' });
  await waitFor<void>((resolve) => {
    const poll = setInterval(() => {
      if (snapshots.length === 2) {
        clearInterval(poll);
        resolve();
      }
    }, 2);
  });

  assert.deepEqual(sentParams, params);
  assert.deepEqual(snapshots.map((payload) => payload.message.content), ['你', '你好']);
});
