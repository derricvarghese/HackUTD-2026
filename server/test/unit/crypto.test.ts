import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/crypto/canonical';
import { eciesDecrypt, eciesEncrypt } from '../../src/crypto/ecies';
import { generateKeyPair, loadBackendKeys, parseP256PrivateKey, parseP256PublicKey } from '../../src/crypto/keys';
import { envelopeSignedPart, signEcdsa, verifyEcdsa, deviceRequestMessage, sha256Hex } from '../../src/crypto/verify';
import { signReceipt, verifyReceipt } from '../../src/crypto/receipts';
import { buildEnvelope, newTestDevice } from '../../src/testing/envelope';

describe('canonicalJson', () => {
  it('sorts keys recursively, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it('encodes strings like JSON.stringify and handles null/bool', () => {
    expect(canonicalJson({ s: 'a"b\né', n: null, t: true })).toBe('{"n":null,"s":"a\\"b\\né","t":true}');
  });
  it('rejects undefined and non-finite numbers', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
});

describe('ECIES (P-256 ECDH + HKDF-SHA256 + AES-256-GCM)', () => {
  const kp = generateKeyPair();
  const priv = parseP256PrivateKey(kp.privateKey);
  it('round trips and has the documented wire layout', () => {
    const wire = eciesEncrypt(Buffer.from('hello beacon'), kp.publicKey);
    expect(wire[0]).toBe(1);
    expect(wire[1]).toBe(4);
    expect(wire.length).toBe(1 + 65 + 12 + 'hello beacon'.length + 16);
    expect(eciesDecrypt(wire, priv).toString()).toBe('hello beacon');
  });
  it('is randomized per message', () => {
    expect(eciesEncrypt(Buffer.from('x'), kp.publicKey).equals(eciesEncrypt(Buffer.from('x'), kp.publicKey))).toBe(false);
  });
  it('rejects tampering with any byte region and wrong keys', () => {
    const wire = eciesEncrypt(Buffer.from('secret payload'), kp.publicKey);
    for (const idx of [0, 5, 70, wire.length - 20, wire.length - 1]) {
      const bad = Buffer.from(wire); bad[idx] ^= 0x01;
      expect(() => eciesDecrypt(bad, priv)).toThrow();
    }
    expect(() => eciesDecrypt(wire, parseP256PrivateKey(generateKeyPair().privateKey))).toThrow();
    expect(() => eciesDecrypt(wire.subarray(0, 50), priv)).toThrow();
  });
  it('matches an independent derivation from the documented spec', () => {
    // re-implement decrypt from docs/crypto.md using only raw primitives
    const wire = eciesEncrypt(Buffer.from('interop'), kp.publicKey);
    const eph = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: wire.subarray(2, 34).toString('base64url'), y: wire.subarray(34, 66).toString('base64url') }, format: 'jwk' });
    const shared = crypto.diffieHellman({ privateKey: priv, publicKey: eph });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('beacon-ecies-v1'), 32));
    const d = crypto.createDecipheriv('aes-256-gcm', key, wire.subarray(66, 78));
    d.setAAD(wire.subarray(0, 66));
    d.setAuthTag(wire.subarray(wire.length - 16));
    expect(Buffer.concat([d.update(wire.subarray(78, wire.length - 16)), d.final()]).toString()).toBe('interop');
  });
});

describe('signatures', () => {
  it('verifies the canonical signed part and rejects any covered-field change but ignores hop fields', () => {
    const dev = newTestDevice();
    const backend = generateKeyPair();
    const env = buildEnvelope({ device: dev, backendEncPublicKey: backend.publicKey, payload: { lat: 1, lng: 2, category: 'trapped' }, hopCount: 2, hopPath: ['A1'] });
    const key = parseP256PublicKey(dev.publicKey);
    expect(verifyEcdsa(key, envelopeSignedPart(env), env.signature)).toBe(true);
    expect(verifyEcdsa(key, envelopeSignedPart({ ...env, hop_count: 9, hop_path: ['X'] } as typeof env), env.signature)).toBe(true);
    for (const t of [{ max_hops: 9 }, { expires_at: '2030-01-01T00:00:00.000Z' }, { tier: 'high' }, { payload: 'AAAA' }, { routing: { approx: { lat: 0, lng: 0, radius_m: 1 } } }, { id: crypto.randomUUID() }]) {
      expect(verifyEcdsa(key, envelopeSignedPart({ ...env, ...t } as typeof env), env.signature)).toBe(false);
    }
  });
  it('device request message format', () => {
    expect(deviceRequestMessage('post', '/v1/sos/batch', '{"a":1}', '2026-11-07T00:00:00Z')).toBe(`POST\n/v1/sos/batch\n${sha256Hex('{"a":1}')}\n2026-11-07T00:00:00Z`);
  });
  it('receipts verify and detect tampering', () => {
    const k = loadBackendKeys('', '');
    const pub = crypto.createPublicKey(k.signPrivate);
    const r = signReceipt(k.signPrivate, crypto.randomUUID());
    expect(verifyReceipt(pub, r)).toBe(true);
    expect(verifyReceipt(pub, { ...r, id: crypto.randomUUID() })).toBe(false);
    expect(verifyReceipt(pub, { ...r, hop_count: 3 })).toBe(true); // hop_count is mutable by relays
  });
  it('signEcdsa/verifyEcdsa garbage safe', () => {
    const k = parseP256PrivateKey(generateKeyPair().privateKey);
    expect(verifyEcdsa(crypto.createPublicKey(k), 'x', 'not base64 !!')).toBe(false);
    expect(verifyEcdsa(crypto.createPublicKey(k), 'x', signEcdsa(k, 'x'))).toBe(true);
  });
});
