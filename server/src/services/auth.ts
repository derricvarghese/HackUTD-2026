import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { components } from '../generated/api';
import type { Ctx } from '../ctx';
import { tooMany, unauthorized } from '../errors';
import { checkPassword, toResponder } from './responders';
import type { ResponderRow } from '../db/types';

export type AuthTokens = components['schemas']['AuthTokens'];
export interface AccessClaims { sub: string; role: ResponderRow['role']; name: string; exp: number }

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function signAccess(ctx: Ctx, r: ResponderRow): string {
  return jwt.sign({ role: r.role, name: r.name }, ctx.cfg.JWT_SECRET, { subject: r.id, expiresIn: ctx.cfg.ACCESS_TOKEN_TTL_S, algorithm: 'HS256' });
}

export function verifyAccess(ctx: Ctx, token: string): AccessClaims | null {
  try {
    const c = jwt.verify(token, ctx.cfg.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!c.sub || !c.role) return null;
    return { sub: c.sub, role: c.role, name: c.name, exp: c.exp! };
  } catch {
    return null;
  }
}

async function issue(ctx: Ctx, r: ResponderRow): Promise<AuthTokens> {
  const refresh = crypto.randomBytes(32).toString('base64url');
  await ctx.db.insertInto('refresh_tokens').values({
    responder_id: r.id, token_hash: sha(refresh), expires_at: new Date(Date.now() + ctx.cfg.REFRESH_TOKEN_TTL_S * 1000),
  }).execute();
  await ctx.db.updateTable('responders').set({ last_seen_at: new Date() }).where('id', '=', r.id).execute();
  return {
    access_token: signAccess(ctx, r), refresh_token: refresh, token_type: 'Bearer', expires_in: ctx.cfg.ACCESS_TOKEN_TTL_S,
    responder: toResponder(r),
  };
}

export async function login(ctx: Ctx, ip: string, username: string, password: string): Promise<AuthTokens> {
  const rl = ctx.limiters.login.take(`${ip}|${username.toLowerCase()}`);
  if (!rl.ok) throw tooMany(rl.retryAfterS);
  const r = await ctx.db.selectFrom('responders').selectAll().where('username', '=', username).where('active', '=', true).executeTakeFirst();
  // compare against a dummy hash when the user is unknown so timing does not reveal valid usernames
  const ok = await checkPassword(password, r?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
  if (!r || !ok) throw unauthorized('Invalid username or password');
  return issue(ctx, r);
}

/** Rotating refresh: the presented token is revoked, a new pair is issued. Re-use of a revoked token fails. */
export async function refresh(ctx: Ctx, token: string): Promise<AuthTokens> {
  const hash = sha(token);
  const revoked = await ctx.db.updateTable('refresh_tokens').set({ revoked: true, updated_at: new Date() })
    .where('token_hash', '=', hash).where('revoked', '=', false).where('expires_at', '>', new Date()).returning('responder_id').executeTakeFirst();
  if (!revoked) throw unauthorized('Invalid refresh token');
  const r = await ctx.db.selectFrom('responders').selectAll().where('id', '=', revoked.responder_id).where('active', '=', true).executeTakeFirst();
  if (!r) throw unauthorized('Invalid refresh token');
  return issue(ctx, r);
}

export async function logout(ctx: Ctx, responderId: string, token?: string) {
  let q = ctx.db.updateTable('refresh_tokens').set({ revoked: true, updated_at: new Date() }).where('responder_id', '=', responderId);
  if (token) q = q.where('token_hash', '=', sha(token));
  await q.execute();
}
