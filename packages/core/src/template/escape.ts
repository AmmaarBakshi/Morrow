const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escape a value for HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]!);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  colon: ':',
  tab: '\t',
  newline: '\n',
  lpar: '(',
  rpar: ')',
  sol: '/',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
  trade: '™',
  euro: '€',
  pound: '£',
  rupee: '₹',
};

/** Decode numeric and common named HTML entities. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;
const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?([/?#].*)?$/i;

/**
 * Make a merge value safe for use as a complete URL. Returns null when the value
 * cannot be made safe (e.g. `javascript:`), so callers can substitute `#`.
 */
export function sanitizeUrl(value: string): string | null {
  // Remove whitespace and control characters browsers ignore inside schemes.
  const compact = decodeEntities(value).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (!compact) return null;
  if (SAFE_SCHEME.test(compact)) return value.trim();
  if (compact.startsWith('/') && !compact.startsWith('//')) return value.trim();
  if (compact.startsWith('#')) return value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(compact)) return null; // any other scheme
  if (BARE_DOMAIN.test(compact)) return `https://${value.trim()}`;
  return null;
}

/** True when a static attribute value would execute script or embed active content. */
export function isDangerousUrl(value: string): boolean {
  const compact = decodeEntities(value)
    .replace(/[\u0000- \u007f-\u009f]/g, '')
    .toLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:') || compact.startsWith('livescript:')) return true;
  if (compact.startsWith('data:')) return !/^data:image\/(png|gif|jpe?g|webp);base64,/.test(compact);
  return false;
}

// CR, LF and the Unicode line/paragraph separators (U+2028, U+2029).
const LINE_BREAKS = new RegExp(`[\r\n${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');

/** Remove characters that could break e-mail headers (CR/LF injection). */
export function sanitizeHeaderValue(value: string): string {
  return value
    .replace(LINE_BREAKS, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
