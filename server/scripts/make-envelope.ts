/**
 * Prints a valid signed+encrypted batch body for manual testing / Android interop fixtures.
 *   npx tsx scripts/make-envelope.ts http://localhost:3000   (fetches /v1/server-info for the encryption key)
 * Output: JSON { device: {public_key, private_key_pkcs8}, body: {envelopes:[...]} }. Register `public_key` via POST /v1/devices first,
 * then set sender_key_id to the returned device id (or leave the public key inline: the server auto-registers it).
 */
import { buildEnvelope, newTestDevice } from '../src/testing/envelope';

(async () => {
  const base = process.argv[2] ?? 'http://localhost:3000';
  const info = (await (await fetch(`${base}/v1/server-info`)).json()) as { encryption_public_key: string };
  const device = newTestDevice();
  const env = buildEnvelope({
    device, backendEncPublicKey: info.encryption_public_key, hopCount: 3, hopPath: ['A1', 'B7', 'C3'],
    payload: { lat: 32.9857, lng: -96.7501, category: 'trapped', text: 'Trapped, 2 people, water rising', people_count: 2, trapped: true, water_rising: true },
  });
  console.log(JSON.stringify({
    device: { public_key: device.publicKey, private_key_pkcs8: device.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') },
    body: { envelopes: [env] },
  }, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
