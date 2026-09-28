import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { createIdentity } from '../electron/identity.js';
import { SettingsStore, type SecretCodec } from '../electron/store.js';

const MAGIC = Buffer.from('kuro-test-aes-gcm-v1\0', 'utf8');

class MemoryAesCodec implements SecretCodec {
  readonly key = randomBytes(32);

  isEncryptionAvailable(): boolean {
    return true;
  }

  encryptString(value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  decryptString(value: Buffer): string {
    const minimumLength = MAGIC.length + 12 + 16;
    if (value.length < minimumLength || !value.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('invalid sealed payload');
    }
    const ivStart = MAGIC.length;
    const tagStart = ivStart + 12;
    const ciphertextStart = tagStart + 16;
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(ivStart, tagStart));
    decipher.setAuthTag(value.subarray(tagStart, ciphertextStart));
    return Buffer.concat([
      decipher.update(value.subarray(ciphertextStart)),
      decipher.final(),
    ]).toString('utf8');
  }
}

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'kuro-store-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('persisted bytes and public settings never expose credentials or private identity material', (t) => {
  const directory = temporaryDirectory(t);
  const codec = new MemoryAesCodec();
  const store = new SettingsStore(directory, codec, createIdentity);
  const originalIdentity = store.getConnection().identity;
  const token = 'shared-token-very-long-unique-7d4209d8';
  const password = 'gateway-password-very-long-unique-f313c650';
  const deviceToken = 'device-token-very-long-unique-2f9a3e11';

  store.save({
    url: 'ws://127.0.0.1:18789/',
    distro: 'Ubuntu-24.04',
    token,
    password,
  });
  store.saveDeviceToken(deviceToken, ['operator.read', 'operator.write']);

  const raw = readFileSync(join(directory, 'connection.sealed'));
  for (const secret of [token, password, deviceToken, originalIdentity.privateKeyPem]) {
    assert.equal(raw.includes(Buffer.from(secret, 'utf8')), false);
  }

  const publicSettings = store.getPublicSettings();
  assert.deepEqual(Object.keys(publicSettings).sort(), [
    'credentialSource',
    'distro',
    'hasCredential',
    'url',
  ]);
  assert.equal(publicSettings.hasCredential, true);
  const publicJson = JSON.stringify(publicSettings);
  for (const secret of [token, password, deviceToken, originalIdentity.privateKeyPem]) {
    assert.equal(publicJson.includes(secret), false);
  }
});

test('reload decrypts the same identity, credentials, and device token without generating a replacement', (t) => {
  const directory = temporaryDirectory(t);
  const codec = new MemoryAesCodec();
  let identitiesCreated = 0;
  const identityFactory = () => {
    identitiesCreated += 1;
    return createIdentity();
  };
  const first = new SettingsStore(directory, codec, identityFactory);
  first.save({
    url: 'ws://127.0.0.1:18789/',
    distro: 'Ubuntu-24.04',
    token: 'reload-shared-token',
    password: 'reload-password',
  });
  first.saveDeviceToken('reload-device-token', ['operator.read']);
  const expectedConnection = first.getConnection();

  const reloaded = new SettingsStore(directory, codec, identityFactory);

  assert.equal(identitiesCreated, 1);
  assert.deepEqual(reloaded.getConnection(), expectedConnection);
  assert.deepEqual(reloaded.getPublicSettings(), first.getPublicSettings());
});

test('saving a blank token on the same endpoint preserves the existing credential', (t) => {
  const directory = temporaryDirectory(t);
  const store = new SettingsStore(directory, new MemoryAesCodec(), createIdentity);
  store.save({
    url: 'ws://127.0.0.1:18789/',
    distro: 'Ubuntu-24.04',
    token: 'credential-to-preserve',
  });

  const publicSettings = store.save({
    url: 'ws://127.0.0.1:18789/',
    distro: 'Ubuntu-24.04',
    token: '   ',
  });

  assert.equal(store.getConnection().token, 'credential-to-preserve');
  assert.equal(publicSettings.hasCredential, true);
  assert.equal(publicSettings.credentialSource, 'manual');
});

test('changing either endpoint or distro clears credentials and device tokens but keeps the device identity', (t) => {
  const directory = temporaryDirectory(t);
  const store = new SettingsStore(directory, new MemoryAesCodec(), createIdentity);
  const identity = store.getConnection().identity;

  store.save({
    url: 'ws://127.0.0.1:18789/',
    distro: 'Ubuntu-24.04',
    token: 'old-endpoint-token',
    password: 'old-endpoint-password',
  });
  store.saveDeviceToken('old-endpoint-device-token', ['operator.read']);
  const endpointSettings = store.save({
    url: 'ws://localhost:18789/',
    distro: 'Ubuntu-24.04',
  });
  assert.deepEqual(store.getConnection(), {
    url: 'ws://localhost:18789/',
    token: undefined,
    password: undefined,
    identity,
    deviceToken: undefined,
  });
  assert.equal(endpointSettings.hasCredential, false);
  assert.equal(endpointSettings.credentialSource, 'none');

  store.save({
    url: 'ws://localhost:18789/',
    distro: 'Ubuntu-24.04',
    token: 'old-distro-token',
  });
  store.saveDeviceToken('old-distro-device-token', ['operator.write']);
  const distroSettings = store.save({
    url: 'ws://localhost:18789/',
    distro: 'Debian',
  });
  assert.deepEqual(store.getConnection(), {
    url: 'ws://localhost:18789/',
    token: undefined,
    password: undefined,
    identity,
    deviceToken: undefined,
  });
  assert.equal(distroSettings.hasCredential, false);
  assert.equal(distroSettings.credentialSource, 'none');
});

test('unavailable encryption refuses initialization before identity or sealed data is created', (t) => {
  const directory = temporaryDirectory(t);
  let identityCreated = false;
  const unavailableCodec: SecretCodec = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('must not encrypt'); },
    decryptString: () => { throw new Error('must not decrypt'); },
  };

  assert.throws(() => new SettingsStore(directory, unavailableCodec, () => {
    identityCreated = true;
    return createIdentity();
  }));
  assert.equal(identityCreated, false);
  assert.equal(existsSync(join(directory, 'connection.sealed')), false);
});

test('a corrupt encrypted store fails closed without replacement or overwrite', (t) => {
  const directory = temporaryDirectory(t);
  const codec = new MemoryAesCodec();
  const sealedFile = join(directory, 'connection.sealed');
  new SettingsStore(directory, codec, createIdentity);
  const corruptBytes = Buffer.from(readFileSync(sealedFile));
  corruptBytes[corruptBytes.length - 1] ^= 0xff;
  writeFileSync(sealedFile, corruptBytes);
  let identityCreated = false;

  assert.throws(() => new SettingsStore(directory, codec, () => {
    identityCreated = true;
    return createIdentity();
  }));
  assert.equal(identityCreated, false);
  assert.deepEqual(readFileSync(sealedFile), corruptBytes);
});

test('explicit credential-free settings survive restart without initial WSL discovery', (t) => {
  const directory = temporaryDirectory(t);
  const codec = new MemoryAesCodec();
  const first = new SettingsStore(directory, codec, createIdentity);
  assert.equal(first.needsInitialDiscovery(), true);
  first.save({ url: 'ws://127.0.0.1:19999/', distro: 'Debian' });
  const restarted = new SettingsStore(directory, codec, createIdentity);
  assert.equal(restarted.needsInitialDiscovery(), false);
  assert.equal(restarted.getConnection().url, 'ws://127.0.0.1:19999/');
  assert.equal(restarted.getPublicSettings().credentialSource, 'none');
});

test('untouched settings retain discovery intent while legacy imported settings migrate as configured', (t) => {
  const directory = temporaryDirectory(t);
  const codec = new MemoryAesCodec();
  new SettingsStore(directory, codec, createIdentity);
  assert.equal(new SettingsStore(directory, codec, createIdentity).needsInitialDiscovery(), true);
  const file = join(directory, 'connection.sealed');
  const legacy = JSON.parse(codec.decryptString(readFileSync(file)));
  delete legacy.configured;
  legacy.credentialSource = 'wsl';
  writeFileSync(file, codec.encryptString(JSON.stringify(legacy)));
  assert.equal(new SettingsStore(directory, codec, createIdentity).needsInitialDiscovery(), false);
});
