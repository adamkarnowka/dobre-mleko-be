import { connect, type ClientHttp2Session } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type { Sql } from './db.js';

/** A device to notify (a row of `devices`). */
export interface PushTarget {
  token: string;
  platform: 'ios' | 'android';
  environment: 'sandbox' | 'production';
  app_id: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opens this place when the notification is tapped. */
  placeId?: string | null;
}

/** `gone`: the token is no longer valid (app removed, notifications reset) — the device is forgotten. */
export type PushResult = 'delivered' | 'gone' | 'failed';

export interface PushSender {
  /** False without credentials: nothing is sent, every device counts as failed. */
  readonly configured: boolean;
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
  close(): void;
}

export interface ApnsCredentials {
  /** Contents of the .p8 key (PEM); `\n` escapes are accepted. */
  key: string;
  keyId: string;
  teamId: string;
}

/** Without APNs credentials (local development, tests). */
export class DisabledPushSender implements PushSender {
  readonly configured = false;
  async send(): Promise<PushResult> {
    return 'failed';
  }
  close(): void {}
}

const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

/** Reasons APNs gives for tokens that will never work again. */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

/**
 * Apple Push Notification service over HTTP/2 with a token (.p8 key): one connection per environment, a JWT
 * refreshed every 50 minutes (Apple accepts 20–60).
 */
export class ApnsSender implements PushSender {
  readonly configured = true;
  private sessions = new Map<string, ClientHttp2Session>();
  private jwt: { value: string; at: number } | null = null;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly now: () => number = Date.now,
    /** APNs hosts per environment (tests point them at a local HTTP/2 server). */
    private readonly hosts: Record<PushTarget['environment'], string> = APNS_HOSTS,
  ) {}

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    if (target.platform !== 'ios') return 'failed'; // Android (FCM) is not supported yet.
    const payload = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
      ...(message.placeId ? { place_id: message.placeId } : {}),
    });
    const { status, reason } = await this.request(target, payload, await this.token());
    if (status === 200) return 'delivered';
    if (status === 410 || (status === 400 && reason && GONE_REASONS.has(reason))) return 'gone';
    return 'failed';
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private async token(): Promise<string> {
    const at = Math.floor(this.now() / 1000);
    if (this.jwt && at - this.jwt.at < 50 * 60) return this.jwt.value;
    const key = await importPKCS8(this.credentials.key.replace(/\\n/g, '\n'), 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.credentials.keyId })
      .setIssuer(this.credentials.teamId)
      .setIssuedAt(at)
      .sign(key);
    this.jwt = { value, at };
    return value;
  }

  private session(environment: PushTarget['environment']): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.hosts[environment]);
    session.on('error', () => this.sessions.delete(environment));
    session.on('close', () => this.sessions.delete(environment));
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  private request(target: PushTarget, payload: string, jwt: string): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve) => {
      const req = this.session(target.environment).request({
        ':method': 'POST',
        ':path': `/3/device/${target.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': target.app_id,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.setTimeout(10_000, () => req.close());
      req.on('response', (headers) => (status = Number(headers[':status'])));
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        resolve({ status, reason });
      });
      req.on('error', () => resolve({ status: 0 }));
      req.end(payload);
    });
  }
}

export type PushKind = 'new_place' | 'new_comment' | 'admin';

export interface PushCounts {
  recipients: number;
  devices: number;
  delivered: number;
  failed: number;
}

/**
 * Sends a message to people's devices, forgets tokens APNs rejects for good, and logs what was sent. Event
 * notifications (new place, comment) run in the background so the request does not wait for Apple.
 */
export class Notifier {
  private pending = new Set<Promise<unknown>>();

  constructor(
    private readonly sql: Sql,
    readonly sender: PushSender,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  async deliver(
    kind: PushKind,
    userIds: string[],
    message: PushMessage,
    audience: Record<string, unknown>,
    sentBy: string | null = null,
  ): Promise<PushCounts> {
    const recipients = [...new Set(userIds)];
    const devices = recipients.length
      ? await this.sql<PushTarget[]>`
          select token, platform, environment, app_id from devices where user_id = any(${recipients}::uuid[])
        `
      : [];
    const results = await Promise.all(
      devices.map((d) => this.sender.send(d, message).catch((): PushResult => 'failed')),
    );
    const gone = devices.filter((_, i) => results[i] === 'gone').map((d) => d.token);
    if (gone.length) await this.sql`delete from devices where token = any(${gone})`;
    const counts = {
      recipients: recipients.length,
      devices: devices.length,
      delivered: results.filter((r) => r === 'delivered').length,
      failed: results.filter((r) => r !== 'delivered').length,
    };
    await this.sql`
      insert into push_log (kind, title, body, place_id, sent_by, audience, recipients, devices, delivered, failed)
      values (${kind}, ${message.title}, ${message.body}, ${message.placeId ?? null}, ${sentBy},
              ${this.sql.json(audience as never)}, ${counts.recipients}, ${counts.devices}, ${counts.delivered},
              ${counts.failed})
    `;
    return counts;
  }

  /** Runs after the response; errors are only logged. */
  background(work: () => Promise<unknown>): void {
    const run = work().catch(this.onError);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  /** Waits for background notifications (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
