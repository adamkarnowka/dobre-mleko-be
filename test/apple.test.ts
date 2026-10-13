import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAppleVerifier } from '../src/auth.js';
import { login, setup } from './helpers.js';

const h = setup();

const signIn = (id_token: string, name?: string) =>
  h.app.inject({ method: 'POST', url: '/auth/apple', payload: { id_token, name } });

describe('Sign in with Apple', () => {
  it('signs in a whitelisted e-mail, with the name Apple gave the app', async () => {
    const res = await signIn('apple:001:ola@gmail.com', 'Ola Nowak');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      has_profile: false,
      user: { email: 'ola@gmail.com', display_name: 'Ola Nowak' },
    });
  });

  it('is the same account as Google sign-in with the same e-mail', async () => {
    const google = await login(h.app, 'kuba@gmail.com');
    const apple = await signIn('apple:002:kuba@gmail.com');
    expect(apple.json().user.id).toBe(google.id);
  });

  it('finds the account by its Apple id when the token has no e-mail', async () => {
    const first = (await signIn('apple:003:tomek@gmail.com')).json();
    const again = await signIn('apple:003:');
    expect(again.statusCode).toBe(200);
    expect(again.json().user.id).toBe(first.user.id);
    expect((await signIn('apple:999:')).json().error).toBe('not_authorized');
  });

  it('rejects e-mails off the list, Hide My Email addresses and unverified e-mails', async () => {
    expect((await signIn('apple:004:obcy@gmail.com')).json().error).toBe('not_authorized');
    const hidden = await signIn('apple:005:abc123@privaterelay.appleid.com:private');
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json().error).toBe('private_email');
    expect((await signIn('apple:006:ola@gmail.com:unverified')).json().error).toBe('email_not_verified');
    expect((await signIn('garbage')).statusCode).toBe(401);
    const [{ n }] = await h.sql<[{ n: number }]>`select count(*)::int as n from users`;
    expect(n).toBe(0);
  });

  it('cuts off an Apple account removed from the list', async () => {
    await signIn('apple:007:tomek@gmail.com');
    await h.sql`delete from allowed_emails where email = 'tomek@gmail.com'`;
    expect((await signIn('apple:007:')).json().error).toBe('not_authorized');
  });
});

describe('Apple identity token verification', () => {
  async function keys() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const sign = (claims: Record<string, unknown>, aud = 'pl.dobremleko.app', iss = 'https://appleid.apple.com') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject('000123.abc')
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);
    return { set: createLocalJWKSet({ keys: [jwk] }), sign };
  }

  it('accepts a token for the app and reads the e-mail flags (strings or booleans)', async () => {
    const { set, sign } = await keys();
    const verify = createAppleVerifier(['pl.dobremleko.app'], set);
    expect(
      await verify(await sign({ email: 'Ola@Gmail.com', email_verified: 'true', is_private_email: 'false' })),
    ).toEqual({ sub: '000123.abc', email: 'ola@gmail.com', emailVerified: true, privateEmail: false });
    expect(
      await verify(await sign({ email: 'x@privaterelay.appleid.com', email_verified: true, is_private_email: true })),
    ).toMatchObject({ privateEmail: true, emailVerified: true });
    expect(await verify(await sign({}))).toMatchObject({ email: null });
  });

  it('rejects another audience or issuer, a forged signature, and no configured app', async () => {
    const { set, sign } = await keys();
    const other = await keys();
    const verify = createAppleVerifier(['pl.dobremleko.app'], set);
    await expect(verify(await sign({}, 'com.other.app'))).rejects.toMatchObject({ code: 'invalid_apple_token' });
    await expect(verify(await sign({}, 'pl.dobremleko.app', 'https://evil.example'))).rejects.toMatchObject({
      code: 'invalid_apple_token',
    });
    await expect(verify(await other.sign({}))).rejects.toMatchObject({ code: 'invalid_apple_token' });
    await expect(createAppleVerifier([], set)(await sign({}))).rejects.toMatchObject({ code: 'invalid_apple_token' });
  });
});
