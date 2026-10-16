import { decodeEntities } from './escape';

/**
 * Convert e-mail HTML into a readable plain-text alternative.
 * Links become "text (url)", list items become "- item", block elements
 * become line breaks. Template tags are preserved, so this can run on
 * template source as well as on rendered output.
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    const url = href.trim();
    if (!text) return url;
    if (!url || url.startsWith('#') || decodeEntities(text) === decodeEntities(url)) return text;
    return `${text} (${url})`;
  });
  s = s.replace(/<img\b[^>]*?\balt\s*=\s*(["'])(.*?)\1[^>]*>/gi, (_m, _q, alt: string) => (alt.trim() ? `[${alt.trim()}]` : ''));
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<hr\b[^>]*>/gi, '\n---\n');
  s = s.replace(/<\/(p|div|h[1-6]|blockquote|section|article|header|footer|table)\s*>/gi, '\n\n');
  s = s.replace(/<\/(tr|ul|ol)\s*>/gi, '\n');
  s = s.replace(/<\/(td|th)\s*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\u00A0/g, ' ');
  const lines = s.split(/\r?\n/).map((line) => line.replace(/[ \t]+/g, ' ').trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Insert hidden preview text (pre-header) right after <body>. */
export function injectPreheader(html: string, preheader: string, escape: (s: string) => string): string {
  if (!preheader.trim()) return html;
  const block =
    `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">` +
    `${escape(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(12)}</div>`;
  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, at) + block + html.slice(at);
  }
  return block + html;
}

/** Append HTML just before </body>, or at the end when there is no body tag. */
export function appendToBody(html: string, fragment: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + fragment;
  return html.slice(0, idx) + fragment + html.slice(idx);
}
