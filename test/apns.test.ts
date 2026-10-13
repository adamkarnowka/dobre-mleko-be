import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApnsSender, type PushTarget } from '../src/push.js';

/** A local HTTP/2 server standing in for APNs: records requests and answers by token. */
const requests: { headers: IncomingHttpHeaders; body: string }[] = [];
const answers: Record<string, [number, string?]> = {
  ok: [200],
  gone: [410, 'Unregistered'],
  bad: [400, 'BadDeviceToken'],
  topic: [400, 'TopicDisallowed'],
  down: [500, 'InternalServerError'],
};
let server: Http2Server;
let host: string;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      const token = String(req.headers[':path']).split('/').pop()!;
      const [status, reason] = answers[token] ?? [200];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(reason ? JSON.stringify({ reason }) : '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  host = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const target = (token: string): PushTarget => ({
  token,
  platform: 'ios',
  environment: 'sandbox',
  app_id: 'pl.dobremleko.app.dev',
});

describe('APNs sender', () => {
  it('sends an alert with a signed token, the topic and the place to open', async () => {
    // The key as an environment variable often has `\n` escapes instead of line breaks.
    const sender = new ApnsSender(
      { key: pem.replace(/\n/g, '\\n'), keyId: 'KEY1234567', teamId: '7B2UZA63WA' },
      Date.now,
      {
        sandbox: host,
        production: 'http://localhost:1',
      },
    );
    expect(await sender.send(target('ok'), { title: 'Nowe miejsce', body: 'Ola poleca', placeId: 'p1' })).toBe(
      'delivered',
    );
    const { headers, body } = requests.at(-1)!;
    expect(headers[':path']).toBe('/3/device/ok');
    expect(headers['apns-topic']).toBe('pl.dobremleko.app.dev');
    expect(headers['apns-push-type']).toBe('alert');
    expect(JSON.parse(body)).toEqual({
      aps: { alert: { title: 'Nowe miejsce', body: 'Ola poleca' }, sound: 'default' },
      place_id: 'p1',
    });
    const jwt = String(headers.authorization).replace('bearer ', '');
    const key = await importSPKI(publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'ES256');
    const { payload, protectedHeader } = await jwtVerify(jwt, key);
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(payload.iss).toBe('7B2UZA63WA');
    sender.close();
  });

  it('tells dead tokens from other failures', async () => {
    const sender = new ApnsSender({ key: pem, keyId: 'K', teamId: 'T' }, Date.now, {
      sandbox: host,
      production: host,
    });
    expect(await sender.send(target('gone'), { title: 'a', body: 'b' })).toBe('gone');
    expect(await sender.send(target('bad'), { title: 'a', body: 'b' })).toBe('gone');
    expect(await sender.send(target('topic'), { title: 'a', body: 'b' })).toBe('failed');
    expect(await sender.send(target('down'), { title: 'a', body: 'b' })).toBe('failed');
    expect(await sender.send({ ...target('ok'), platform: 'android' }, { title: 'a', body: 'b' })).toBe('failed');
    sender.close();
  });
});
