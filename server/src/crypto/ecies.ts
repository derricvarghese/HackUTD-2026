import crypto, { KeyObject } from 'node:crypto';
import { parseP256PublicKey } from './keys';

/**
 * ECIES over P-256 (documented in docs/crypto.md):
 *   wire = 0x01 || ephemeralPublicKey(65 bytes, X9.62 uncompressed) || nonce(12) || ciphertext || tag(16)
 *   key  = HKDF-SHA256(ikm = ECDH shared secret (32 B), salt = empty, info = "beacon-ecies-v1", L = 32)
 *   AEAD = AES-256-GCM, AAD = 0x01 || ephemeralPublicKey
 */
export const ECIES_VERSION = 0x01;
const INFO = Buffer.from('beacon-ecies-v1', 'utf8');

function rawPointToPublicKey(point: Buffer): KeyObject {
  if (point.length !== 65 || point[0] !== 0x04) throw new Error('bad ephemeral key');
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
}

function deriveKey(shared: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), INFO, 32));
}

export function eciesEncrypt(plaintext: Buffer, recipientPublicKeyB64: string): Buffer {
  const recipient = parseP256PublicKey(recipientPublicKeyB64);
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = eph.publicKey.export({ format: 'jwk' });
  const ephPoint = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = deriveKey(shared);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([Buffer.from([ECIES_VERSION]), ephPoint]));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([ECIES_VERSION]), ephPoint, nonce, ct, cipher.getAuthTag()]);
}

/** Throws on any malformed/tampered input. */
export function eciesDecrypt(wire: Buffer, recipientPrivateKey: KeyObject): Buffer {
  if (wire.length < 1 + 65 + 12 + 16 || wire[0] !== ECIES_VERSION) throw new Error('bad ciphertext');
  const ephPoint = wire.subarray(1, 66);
  const nonce = wire.subarray(66, 78);
  const tag = wire.subarray(wire.length - 16);
  const ct = wire.subarray(78, wire.length - 16);
  const shared = crypto.diffieHellman({ privateKey: recipientPrivateKey, publicKey: rawPointToPublicKey(ephPoint) });
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(shared), nonce);
  decipher.setAAD(Buffer.concat([Buffer.from([ECIES_VERSION]), ephPoint]));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
