import crypto, { KeyObject } from 'node:crypto';

export interface KeyPairB64 { publicKey: string; privateKey: string }

/** P-256 key pair; public = base64 X.509 SPKI DER, private = base64 PKCS#8 DER. */
export function generateKeyPair(): KeyPairB64 {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function parseP256PublicKey(b64: string): KeyObject {
  const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('not a P-256 public key');
  }
  return key;
}

export function parseP256PrivateKey(b64: string): KeyObject {
  const key = crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('not a P-256 private key');
  }
  return key;
}

export interface BackendKeys {
  encPrivate: KeyObject;
  encPublicB64: string;
  signPrivate: KeyObject;
  signPublicB64: string;
  ephemeral: boolean;
}

export function loadBackendKeys(encPriv: string, signPriv: string): BackendKeys {
  let ephemeral = false;
  if (!encPriv) { encPriv = generateKeyPair().privateKey; ephemeral = true; }
  if (!signPriv) { signPriv = generateKeyPair().privateKey; ephemeral = true; }
  const encPrivate = parseP256PrivateKey(encPriv);
  const signPrivate = parseP256PrivateKey(signPriv);
  const pub = (k: KeyObject) => crypto.createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('base64');
  return { encPrivate, encPublicB64: pub(encPrivate), signPrivate, signPublicB64: pub(signPrivate), ephemeral };
}
