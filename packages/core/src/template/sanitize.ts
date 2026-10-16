/**
 * Sanitiser for author-supplied e-mail HTML (template bodies and snippets).
 *
 * E-mail HTML legitimately needs <style>, tables, inline styles and Outlook
 * conditional comments, so this is a deny-list sanitiser tuned for e-mail:
 * it removes active content (scripts, frames, plugins, event handlers,
 * javascript:/data: URLs, CSS expressions) while preserving template tags
 * (`{{…}}`) byte-for-byte. Previews are additionally rendered in sandboxed
 * iframes, so this is defence in depth rather than the only barrier.
 */
import { decodeEntities, isDangerousUrl } from './escape';

const DROP_WITH_CONTENT = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'noembed',
  'noframes',
  'frame',
  'frameset',
  'template',
  'portal',
]);

const DROP_TAG_ONLY = new Set([
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'keygen',
  'animate',
  'animatetransform',
  'animatemotion',
  'set',
  'handler',
  'listener',
]);

const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'background',
  'poster',
  'cite',
  'lowsrc',
  'dynsrc',
  'longdesc',
  'xlink:href',
  'data',
  'codebase',
]);

const DROPPED_ATTRIBUTES = new Set(['srcdoc', 'formaction', 'srcset']);

export interface SanitizeResult {
  html: string;
  removed: string[];
}

function cleanCss(css: string): { css: string; changed: boolean } {
  const decoded = decodeEntities(css);
  let changed = false;
  let out = decoded.replace(/expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding\s*:|@import[^;]*;?/gi, () => {
    changed = true;
    return '';
  });
  out = out.replace(/url\(\s*(['"]?)\s*(javascript|vbscript|data:(?!image\/(png|gif|jpe?g|webp);base64))[^)]*\)/gi, () => {
    changed = true;
    return 'none';
  });
  return { css: changed ? out : css, changed };
}

/** Index just past a `{{…}}` template tag starting at `i`, or -1 when unclosed. */
function templateTagEnd(src: string, i: number): number {
  const close = src.indexOf('}}', i + 2);
  return close === -1 ? -1 : close + 2;
}

function sanitizeAttributes(raw: string, removed: string[]): string {
  let out = '';
  let k = 0;
  const n = raw.length;
  while (k < n) {
    const ch = raw[k]!;
    if (/\s|\//.test(ch)) {
      k++;
      continue;
    }
    if (raw.startsWith('{{', k)) {
      const end = templateTagEnd(raw, k);
      const stop = end === -1 ? n : end;
      out += ` ${raw.slice(k, stop)}`;
      k = stop;
      continue;
    }
    // attribute name
    let nameEnd = k;
    while (nameEnd < n && !/[\s=/>]/.test(raw[nameEnd]!) && !raw.startsWith('{{', nameEnd)) nameEnd++;
    const name = raw.slice(k, nameEnd);
    k = nameEnd;
    while (k < n && /\s/.test(raw[k]!)) k++;
    let rawValue: string | undefined;
    let value: string | undefined;
    if (raw[k] === '=') {
      k++;
      while (k < n && /\s/.test(raw[k]!)) k++;
      const quote = raw[k] === '"' || raw[k] === "'" ? raw[k]! : null;
      const start = k;
      if (quote) {
        k++;
        while (k < n && raw[k] !== quote) {
          if (raw.startsWith('{{', k)) {
            const end = templateTagEnd(raw, k);
            k = end === -1 ? n : end;
          } else {
            k++;
          }
        }
        k = Math.min(n, k + 1);
        rawValue = raw.slice(start, k);
        value = rawValue.slice(1, rawValue.endsWith(quote) && rawValue.length > 1 ? -1 : undefined);
      } else {
        while (k < n && !/\s/.test(raw[k]!)) {
          if (raw.startsWith('{{', k)) {
            const end = templateTagEnd(raw, k);
            k = end === -1 ? n : end;
          } else {
            k++;
          }
        }
        rawValue = raw.slice(start, k);
        value = rawValue;
      }
    }
    if (!name) continue;
    const lname = name.toLowerCase();
    if (lname.startsWith('on')) {
      removed.push(`${lname} attribute`);
      continue;
    }
    if (DROPPED_ATTRIBUTES.has(lname)) {
      removed.push(`${lname} attribute`);
      continue;
    }
    if (value !== undefined && URL_ATTRIBUTES.has(lname)) {
      // Template expressions are checked at render time; check the static text.
      const staticPart = value.replace(/\{\{[\s\S]*?\}\}/g, '');
      if (!value.trim().startsWith('{{') && isDangerousUrl(staticPart)) {
        removed.push(`unsafe ${lname} URL`);
        continue;
      }
    }
    if (value !== undefined && lname === 'style') {
      const cleaned = cleanCss(value);
      if (cleaned.changed) {
        removed.push('unsafe CSS');
        out += ` ${name}="${cleaned.css.replace(/"/g, '&quot;')}"`;
        continue;
      }
    }
    out += rawValue === undefined ? ` ${name}` : ` ${name}=${rawValue}`;
  }
  return out;
}

export function sanitizeTemplateHtml(src: string): SanitizeResult {
  const removed: string[] = [];
  let out = '';
  let i = 0;
  const n = src.length;
  const lower = src.toLowerCase();

  while (i < n) {
    if (src.startsWith('{{', i)) {
      const end = templateTagEnd(src, i);
      const stop = end === -1 ? n : end;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (src[i] !== '<') {
      const next = src.slice(i).search(/<|\{\{/);
      const stop = next === -1 ? n : i + next;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      const end = src.indexOf('>', i);
      const stop = end === -1 ? n : end + 1;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(i, i + 64));
    if (!m) {
      out += '&lt;';
      i++;
      continue;
    }
    const isEnd = m[1] === '/';
    const name = m[2]!;
    const lname = name.toLowerCase();

    // Find the end of the tag, respecting quotes and template tags.
    let k = i + m[0].length;
    let quote: string | null = null;
    while (k < n) {
      if (!quote && src.startsWith('{{', k)) {
        const end = templateTagEnd(src, k);
        k = end === -1 ? n : end;
        continue;
      }
      const c = src[k]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      k++;
    }
    const rawAttrs = src.slice(i + m[0].length, k);
    i = Math.min(n, k + 1);

    if (DROP_WITH_CONTENT.has(lname)) {
      if (!isEnd) {
        removed.push(`<${lname}>`);
        const closeIdx = lower.indexOf(`</${lname}`, i);
        if (closeIdx === -1) {
          i = n;
        } else {
          const gt = src.indexOf('>', closeIdx);
          i = gt === -1 ? n : gt + 1;
        }
      }
      continue;
    }
    if (DROP_TAG_ONLY.has(lname)) {
      if (!isEnd) removed.push(`<${lname}>`);
      continue;
    }
    if (isEnd) {
      out += `</${name}>`;
      continue;
    }
    const attrs = sanitizeAttributes(rawAttrs, removed);
    if (lname === 'meta' && /http-equiv\s*=\s*["']?\s*refresh/i.test(attrs)) {
      removed.push('<meta refresh>');
      continue;
    }
    if (lname === 'link' && !/rel\s*=\s*["']?stylesheet/i.test(attrs)) {
      removed.push('<link>');
      continue;
    }
    const selfClosing = /\/\s*$/.test(rawAttrs);
    out += `<${name}${attrs}${selfClosing ? ' /' : ''}>`;

    if (lname === 'style') {
      const closeIdx = lower.indexOf('</style', i);
      const body = src.slice(i, closeIdx === -1 ? n : closeIdx);
      const cleaned = cleanCss(body);
      if (cleaned.changed) removed.push('unsafe CSS');
      out += cleaned.css;
      i = closeIdx === -1 ? n : closeIdx;
    }
  }
  return { html: out, removed: [...new Set(removed)] };
}
