/**
 * Test/dev helper that plays the role of the Android app: generates a device key, builds signed + encrypted mesh
 * envelopes exactly as documented in docs/crypto.md, and signs REST requests.
 * Also usable from the CLI:  npx tsx scripts/make-envelope.ts --server-info <json file or url>
 */
import crypto, { KeyObject } from 'node:crypto';
import { eciesEncrypt } from '../crypto/ecies';
import { envelopeSignedPart, deviceRequestMessage, signEcdsa } from '../crypto/verify';
import { generateKeyPair, parseP256PrivateKey } from '../crypto/keys';
import { HOP_TABLE, type Kind, type Tier } from '../domain/hops';
import { uuidv7 } from './uuid';

export interface TestDevice { publicKey: string; privateKey: KeyObject; id?: string }

export function newTestDevice(): TestDevice {
  const kp = generateKeyPair();
  return { publicKey: kp.publicKey, privateKey: parseP256PrivateKey(kp.privateKey) };
}

export interface PayloadInput {
  lat: number; lng: number; category: 'injured' | 'trapped' | 'need_water_meds' | 'safe' | 'other';
  text?: string; people_count?: number; trapped?: boolean; water_rising?: boolean; injured?: boolean;
  heartbeat?: { sent_at: string; approx: { lat: number; lng: number; radius_m: number }; battery_pct?: number; charging?: boolean; moving?: boolean; seq?: number };
  [k: string]: unknown;
}

export interface EnvelopeOpts {
  device: TestDevice;
  backendEncPublicKey: string;
  payload: Record<string, unknown>;
  kind?: Kind;
  tier?: Tier;
  id?: string;
  createdAt?: Date;
  expiresAt?: Date;
  maxHops?: number;
  hopCount?: number;
  hopPath?: string[];
  /** put the full public key in the envelope (device not registered yet) */
  inlinePublicKey?: boolean;
  /** approximate routing block; derived from payload when omitted */
  routing?: Record<string, unknown>;
}

const round = (n: number) => Math.round(n * 1e5) / 1e5;

export function buildEnvelope(o: EnvelopeOpts) {
  const kind = o.kind ?? 'sos';
  const tier = o.tier ?? (kind === 'heartbeat' ? 'heartbeat' : 'critical');
  const createdAt = o.createdAt ?? new Date();
  const expiresAt = o.expiresAt ?? new Date(createdAt.getTime() + HOP_TABLE[tier].ttl_seconds * 1000);
  const p = o.payload;
  const routing = o.routing ?? {
    approx: { lat: round(Math.floor(Number(p.lat ?? 0) * 100) / 100 + 0.005), lng: round(Math.floor(Number(p.lng ?? 0) * 100) / 100 + 0.005), radius_m: 1000 },
    ...(p.category ? { category: p.category } : {}),
  };
  const unsigned = {
    id: o.id ?? uuidv7(createdAt.getTime()),
    sender_key_id: o.device.id ?? o.device.publicKey,
    kind, tier,
    max_hops: o.maxHops ?? HOP_TABLE[tier].max_hops,
    expires_at: expiresAt.toISOString(),
    created_at: createdAt.toISOString(),
    routing,
    payload: eciesEncrypt(Buffer.from(JSON.stringify(p), 'utf8'), o.backendEncPublicKey).toString('base64'),
  };
  const signature = signEcdsa(o.device.privateKey, envelopeSignedPart(unsigned));
  return {
    ...unsigned,
    ...(o.inlinePublicKey || !o.device.id ? { sender_public_key: o.device.publicKey } : {}),
    hop_count: o.hopCount ?? 0,
    hop_path: o.hopPath ?? [],
    signature,
  };
}

/** Headers for a device-authenticated REST call. `path` is the path as sent (e.g. /v1/sos/batch), no query string. */
export function signRequest(device: TestDevice, method: string, path: string, body: string | Buffer = '', now = new Date()) {
  const ts = now.toISOString();
  const sig = signEcdsa(device.privateKey, deviceRequestMessage(method, path, body, ts));
  return { 'X-Device-Id': device.id!, 'X-Timestamp': ts, 'X-Device-Signature': sig };
}

export { crypto };
