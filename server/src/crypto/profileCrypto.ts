import crypto from 'node:crypto';

/**
 * At-rest encryption for the sensitive part of a profile (AES-256-GCM).
 * Key = HKDF-SHA256(ikm = PROFILE_ENC_KEY || JWT_SECRET, salt = "beacon-profile-v1", info = "profile-at-rest"), 32 bytes.
 * The row's device id is bound as AAD, so ciphertext cannot be moved between rows. Layout: nonce(12) | tag(16) | ciphertext.
 * Rotating JWT_SECRET without PROFILE_ENC_KEY makes existing blobs undecryptable: set PROFILE_ENC_KEY in production.
 */
export function profileKey(cfg: { PROFILE_ENC_KEY: string; JWT_SECRET: string }): Buffer {
  const ikm = cfg.PROFILE_ENC_KEY || cfg.JWT_SECRET;
  return Buffer.from(crypto.hkdfSync('sha256', ikm, 'beacon-profile-v1', 'profile-at-rest', 32));
}

export function sealProfile(key: Buffer, deviceId: string, data: unknown): Buffer {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(deviceId));
  const ct = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), ct]);
}

export function openProfile<T>(key: Buffer, deviceId: string, blob: Buffer): T {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(deviceId));
  d.setAuthTag(blob.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8')) as T;
}
