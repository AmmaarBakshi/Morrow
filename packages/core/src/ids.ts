/**
 * Prefixed, time-sortable identifiers (similar in spirit to ULIDs).
 *
 *   con_01jb8x6m2q9w3e5r7t9y1u3i5o
 *   ^^^ ^^^^^^^^^^ ^^^^^^^^^^^^^^^^
 *   |   48-bit ms   80 bits of randomness
 *   entity prefix
 *
 * Text IDs keep the schema portable between SQLite and PostgreSQL, sort by
 * creation time (useful for keyset pagination) and are self-describing in logs.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

export const ID_PREFIXES = {
  user: 'usr',
  workspace: 'wsp',
  membership: 'mem',
  invitation: 'inv',
  session: 'ses',
  apiKey: 'key',
  contact: 'con',
  note: 'not',
  contactEvent: 'cev',
  tag: 'tag',
  customField: 'fld',
  segment: 'seg',
  consentEvent: 'cns',
  suppression: 'sup',
  snippet: 'snp',
  template: 'tpl',
  templateVersion: 'tpv',
  sender: 'snd',
  integration: 'int',
  automation: 'aut',
  automationVersion: 'auv',
  automationRun: 'run',
  automationRunStep: 'rst',
  campaign: 'cmp',
  message: 'msg',
  messageEvent: 'mev',
  webhookEvent: 'whe',
  job: 'job',
  task: 'tsk',
  notification: 'ntf',
  audit: 'aud',
  import: 'imp',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function newId(prefix: IdPrefix | string, now: number = Date.now()): string {
  let t = Math.max(0, Math.floor(now));
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  // 256 is divisible by 32, so `b % 32` is uniformly distributed.
  for (const b of randomBytes(16)) rand += ALPHABET[b % 32];
  return `${prefix}_${time}${rand}`;
}

/** Recover the creation timestamp encoded in an ID produced by {@link newId}. */
export function idTimestamp(id: string): number | null {
  const body = id.split('_')[1];
  if (!body || body.length < 10) return null;
  let t = 0;
  for (const ch of body.slice(0, 10)) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    t = t * 32 + v;
  }
  return t;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** URL-safe random token, e.g. for sessions, invitations and API keys. */
export function randomToken(byteLength = 32): string {
  const bytes = randomBytes(byteLength);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}
