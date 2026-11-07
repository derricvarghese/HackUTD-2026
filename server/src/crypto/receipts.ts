import { KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical';
import { signEcdsa, verifyEcdsa } from './verify';

export interface Receipt { id: string; delivered_at: string; max_hops: 5; hop_count: number; signature: string }

/** Signature covers canonical JSON of {id, delivered_at, max_hops} (hop_count is mutable by relays). */
const receiptBody = (id: string, deliveredAt: string) => canonicalJson({ id, delivered_at: deliveredAt, max_hops: 5 });

export function signReceipt(signPrivate: KeyObject, id: string, deliveredAt: Date = new Date()): Receipt {
  const delivered_at = deliveredAt.toISOString();
  return { id, delivered_at, max_hops: 5, hop_count: 0, signature: signEcdsa(signPrivate, receiptBody(id, delivered_at)) };
}

export function verifyReceipt(signPublic: KeyObject, r: Receipt): boolean {
  return verifyEcdsa(signPublic, receiptBody(r.id, r.delivered_at), r.signature);
}

export interface BackendMessageUnsigned {
  id: string; kind: 'delivered' | 'checkin_request' | 'status_update'; sos_id: string; checkin_id: string | null;
  body: Record<string, unknown>; max_hops: number; expires_at: string; created_at: string;
}
export type BackendMessageWire = BackendMessageUnsigned & { hop_count: number; hop_path: string[]; signature: string };

/** Signed part: everything except the relay-mutable hop_count/hop_path. `checkin_id` is always present (null when absent). */
const messageBody = (m: BackendMessageUnsigned) => canonicalJson({
  id: m.id, kind: m.kind, sos_id: m.sos_id, checkin_id: m.checkin_id ?? null, body: m.body, max_hops: m.max_hops, expires_at: m.expires_at, created_at: m.created_at,
});

export function signBackendMessage(signPrivate: KeyObject, m: BackendMessageUnsigned): BackendMessageWire {
  return { ...m, checkin_id: m.checkin_id ?? null, hop_count: 0, hop_path: [], signature: signEcdsa(signPrivate, messageBody(m)) };
}
export function verifyBackendMessage(signPublic: KeyObject, m: BackendMessageWire): boolean {
  return verifyEcdsa(signPublic, messageBody(m), m.signature);
}
