import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

// ---------------------------------------------------------------- hashing

/** SHA-256 hex digest — used to store session tokens and API keys. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** scrypt password hash: `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64!, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64!, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- secrets at rest

function deriveKey(secret: string, purpose: string): Buffer {
  return createHash('sha256').update(`morrow:${purpose}:${secret}`).digest();
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(masterSecret, 'secrets'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, masterSecret: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error('Unsupported secret format');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(masterSecret, 'secrets'), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function encryptJson(value: Record<string, string>, masterSecret: string): string {
  return encryptSecret(JSON.stringify(value), masterSecret);
}

export function decryptJson(payload: string | null | undefined, masterSecret: string): Record<string, string> {
  if (!payload) return {};
  try {
    return JSON.parse(decryptSecret(payload, masterSecret)) as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- signed tokens

/**
 * Compact HMAC-signed token for public links (unsubscribe, tracking,
 * sender verification). Not encrypted: never put secrets in the payload.
 */
export function signToken(payload: Record<string, unknown>, masterSecret: string, purpose: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', deriveKey(masterSecret, `token:${purpose}`)).update(body).digest('base64url').slice(0, 32);
  return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string, masterSecret: string, purpose: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', deriveKey(masterSecret, `token:${purpose}`)).update(body).digest('base64url').slice(0, 32);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
