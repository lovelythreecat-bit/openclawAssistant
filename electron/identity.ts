import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface DeviceHandshake {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (
    der.length !== ED25519_SPKI_PREFIX.length + 32
    || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error('Device public key is not an Ed25519 SPKI key');
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

export function createIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex');
  return { deviceId, publicKeyPem, privateKeyPem };
}

export function signDevice(
  identity: DeviceIdentity,
  nonce: string,
  token: string | undefined,
  signedAt: number,
  scopes: readonly string[] = ['operator.read', 'operator.write'],
): DeviceHandshake {
  const payload = [
    'v3',
    identity.deviceId,
    'gateway-client',
    'ui',
    'operator',
    scopes.join(','),
    String(signedAt),
    token ?? '',
    nonce,
    'win32',
    '',
  ].join('|');

  return {
    id: identity.deviceId,
    publicKey: rawPublicKey(identity.publicKeyPem).toString('base64url'),
    signature: sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(identity.privateKeyPem)).toString('base64url'),
    signedAt,
    nonce,
  };
}
