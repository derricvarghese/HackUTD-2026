import crypto, { KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical';

/** The part of a MeshEnvelope covered by the sender signature (relays mutate hop_count/hop_path, so they are excluded). */
export interface SignedPartInput {
  id: string; sender_key_id: string; kind: string; tier: string; max_hops: number;
  expires_at: string; created_at: string; routing: unknown; payload: string;
}

export function envelopeSignedPart(e: SignedPartInput): string {
  return canonicalJson({
    id: e.id, sender_key_id: e.sender_key_id, kind: e.kind, tier: e.tier, max_hops: e.max_hops,
    expires_at: e.expires_at, created_at: e.created_at, routing: e.routing, payload: e.payload,
  });
}

/** ECDSA P-256 / SHA-256, ASN.1 DER signature, base64. */
export function verifyEcdsa(publicKey: KeyObject, data: string | Buffer, signatureB64: string): boolean {
  try {
    return crypto.verify('sha256', Buffer.from(data), publicKey, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function signEcdsa(privateKey: KeyObject, data: string | Buffer): string {
  return crypto.sign('sha256', Buffer.from(data), privateKey).toString('base64');
}

export const sha256Hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** String signed by devices for authenticated REST calls: METHOD \n PATH \n SHA256hex(body) \n X-Timestamp */
export function deviceRequestMessage(method: string, path: string, body: Buffer | string, timestamp: string): string {
  return `${method.toUpperCase()}\n${path}\n${sha256Hex(body)}\n${timestamp}`;
}
