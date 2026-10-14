import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fcmCredentials } from '../src/app.js';
import { DisabledPushSender, FcmSender, PlatformPushSender, type PushTarget } from '../src/push.js';

/** A local HTTP server standing in for Google's token endpoint and FCM: records requests, answers by token. */
const requests: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
const answers: Record<string, [number, string?]> = {
  ok: [200],
  unregistered: [404, 'UNREGISTERED'],
  mismatch: [403, 'SENDER_ID_MISMATCH'],
  invalid: [400, 'INVALID_ARGUMENT'],
  down: [503, 'UNAVAILABLE'],
};
let server: Server;
let host: string;
let tokenRequests = 0;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ url: req.url!, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        tokenRequests += 1;
        res.end(JSON.stringify({ access_token: `access-${tokenRequests}`, expires_in: 3599, token_type: 'Bearer' }));
        return;
      }
      const token = (JSON.parse(body) as { message: { token: string } }).message.token;
      const [status, code] = answers[token] ?? [200];
      res.statusCode = status;
      res.end(
        code
          ? JSON.stringify({
              error: {
                code: status,
                details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }],
              },
            })
          : JSON.stringify({ name: 'projects/mleko/messages/1' }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  host = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const target = (token: string): PushTarget => ({
  token,
  platform: 'android',
  environment: 'production',
  app_id: 'app.dobremleko',
});

const credentials = { projectId: 'mleko', clientEmail: 'push@mleko.iam.gserviceaccount.com', privateKey: pem };

describe('FCM sender', () => {
  it('sends a notification with the place to open, authorised by the service account', async () => {
    const sender = new FcmSender(
      // The key in an environment variable often has `\n` escapes instead of line breaks.
      { ...credentials, privateKey: pem.replace(/\n/g, '\\n') },
      Date.now,
      { token: `${host}/token`, send: host },
    );
    expect(await sender.send(target('ok'), { title: 'Nowe miejsce', body: 'Ola poleca', placeId: 'p1' })).toBe(
      'delivered',
    );
    const [tokenRequest, send] = requests.slice(-2);
    const assertion = new URLSearchParams(tokenRequest!.body).get('assertion')!;
    const key = await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'RS256');
    const { payload } = await jwtVerify(assertion, key);
    expect(payload).toMatchObject({
      iss: 'push@mleko.iam.gserviceaccount.com',
      aud: `${host}/token`,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
    expect(send!.url).toBe('/v1/projects/mleko/messages:send');
    expect(send!.headers.authorization).toBe(`Bearer access-${tokenRequests}`);
    expect(JSON.parse(send!.body)).toEqual({
      message: {
        token: 'ok',
        notification: { title: 'Nowe miejsce', body: 'Ola poleca' },
        data: { place_id: 'p1' },
        android: { priority: 'HIGH', notification: { sound: 'default' } },
      },
    });
  });

  it('reuses the access token for 50 minutes', async () => {
    let now = Date.now();
    const sender = new FcmSender(credentials, () => now, { token: `${host}/token`, send: host });
    const before = tokenRequests;
    await sender.send(target('ok'), { title: 'a', body: 'b' });
    now += 49 * 60_000;
    await sender.send(target('ok'), { title: 'a', body: 'b' });
    expect(tokenRequests).toBe(before + 1);
    now += 2 * 60_000;
    await sender.send(target('ok'), { title: 'a', body: 'b' });
    expect(tokenRequests).toBe(before + 2);
  });

  it('tells dead tokens from other failures', async () => {
    const sender = new FcmSender(credentials, Date.now, { token: `${host}/token`, send: host });
    expect(await sender.send(target('unregistered'), { title: 'a', body: 'b' })).toBe('gone');
    expect(await sender.send(target('mismatch'), { title: 'a', body: 'b' })).toBe('gone');
    expect(await sender.send(target('invalid'), { title: 'a', body: 'b' })).toBe('failed');
    expect(await sender.send(target('down'), { title: 'a', body: 'b' })).toBe('failed');
    expect(await sender.send({ ...target('ok'), platform: 'ios' }, { title: 'a', body: 'b' })).toBe('failed');
  });
});

describe('platform sender', () => {
  it('sends Android through FCM and iOS through APNs', async () => {
    const fcm = new FcmSender(credentials, Date.now, { token: `${host}/token`, send: host });
    const sender = new PlatformPushSender({ ios: new DisabledPushSender(), android: fcm });
    expect(sender.configured).toBe(true);
    expect(await sender.send(target('ok'), { title: 'a', body: 'b' })).toBe('delivered');
    expect(await sender.send({ ...target('ok'), platform: 'ios' }, { title: 'a', body: 'b' })).toBe('failed');
    expect(
      new PlatformPushSender({ ios: new DisabledPushSender(), android: new DisabledPushSender() }).configured,
    ).toBe(false);
  });

  it('reads the service account key file', () => {
    expect(fcmCredentials('')).toBeNull();
    expect(
      fcmCredentials(
        JSON.stringify({ type: 'service_account', project_id: 'mleko', client_email: 'a@b', private_key: 'k' }),
      ),
    ).toEqual({ projectId: 'mleko', clientEmail: 'a@b', privateKey: 'k' });
    expect(() => fcmCredentials('{"project_id":"mleko"}')).toThrow(/FCM_SERVICE_ACCOUNT/);
  });
});
