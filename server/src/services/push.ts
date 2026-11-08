import crypto from 'node:crypto';
import type { Config } from '../config';
import type { Logger } from '../logger';

/** Notification for a welfare check-in. `data` values are strings (FCM data payloads are string maps). */
export interface PushMessage {
  token: string;
  /** collapse key: a newer message with the same key replaces an undelivered older one */
  collapseKey: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

/** Delivery of a notification to a phone with a `push_token`. Implementations must not throw for normal delivery failures. */
export interface PushProvider {
  readonly name: string;
  send(msg: PushMessage): Promise<void>;
}

/** Default: logs only. Real push needs Firebase credentials (FCM_PROJECT_ID + FCM_SERVICE_ACCOUNT_JSON). */
export class NoopPushProvider implements PushProvider {
  readonly name = 'noop';
  constructor(private log: Logger) {}
  async send(msg: PushMessage): Promise<void> {
    this.log.info({ push: 'noop', collapse_key: msg.collapseKey, checkin_id: msg.data.checkin_id }, 'push not configured: notification not sent');
  }
}

/** FCM HTTP v1 (https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages). OAuth token is minted from the service account. */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  private token?: { value: string; exp: number };
  private sa: { client_email: string; private_key: string; token_uri?: string };
  constructor(private projectId: string, serviceAccountJson: string, private log: Logger, private fetchImpl: typeof fetch = fetch) {
    this.sa = JSON.parse(serviceAccountJson);
  }

  private async accessToken(): Promise<string> {
    const nowS = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > nowS) return this.token.value;
    const uri = this.sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claims = b64({ iss: this.sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: uri, iat: nowS, exp: nowS + 3600 });
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(this.sa.private_key).toString('base64url');
    const r = await this.fetchImpl(uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }) });
    if (!r.ok) throw new Error(`fcm oauth ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: nowS + j.expires_in };
    return j.access_token;
  }

  async send(msg: PushMessage): Promise<void> {
    const token = await this.accessToken();
    const r = await this.fetchImpl(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: msg.token,
          notification: { title: msg.title, body: msg.body },
          data: msg.data,
          android: { priority: 'HIGH', collapse_key: msg.collapseKey, notification: { channel_id: 'welfare_checkin', tag: msg.collapseKey } },
          apns: { headers: { 'apns-priority': '10', 'apns-collapse-id': msg.collapseKey.slice(0, 64) }, payload: { aps: { sound: 'default', 'interruption-level': 'time-sensitive' } } },
        },
      }),
    });
    if (!r.ok) throw new Error(`fcm send ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
}

export function createPush(cfg: Pick<Config, 'FCM_PROJECT_ID' | 'FCM_SERVICE_ACCOUNT_JSON'>, log: Logger): PushProvider {
  if (cfg.FCM_PROJECT_ID && cfg.FCM_SERVICE_ACCOUNT_JSON) {
    try { return new FcmPushProvider(cfg.FCM_PROJECT_ID, cfg.FCM_SERVICE_ACCOUNT_JSON, log); } catch (e) { log.error({ err: (e as Error).message }, 'FCM_SERVICE_ACCOUNT_JSON invalid: push disabled'); }
  }
  return new NoopPushProvider(log);
}
