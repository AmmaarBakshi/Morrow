import { escapeHtml } from '@morrow/core';

export interface PageAction {
  label: string;
  /** Hidden `action` field posted back to the same URL. */
  action: string;
  primary?: boolean;
}

/**
 * Minimal server-rendered page for recipients (unsubscribe, verification).
 * No scripts, no external assets, readable on any device.
 */
export function renderPage(options: { title: string; heading: string; body: string[]; actions?: PageAction[]; footer?: string }): string {
  const paragraphs = options.body.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const actions = (options.actions ?? [])
    .map(
      (a) =>
        `<form method="post"><input type="hidden" name="action" value="${escapeHtml(a.action)}"><button type="submit" class="${a.primary ? 'primary' : ''}">${escapeHtml(a.label)}</button></form>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#111827; --muted:#6b7280; --accent:#4f46e5; --border:#e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0d12; --card:#151821; --fg:#f3f4f6; --muted:#9ca3af; --accent:#818cf8; --border:#262b36; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; background:var(--bg); color:var(--fg);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:32px 28px; }
  h1 { font-size:1.35rem; line-height:1.3; margin:0 0 12px; }
  p { margin:0 0 12px; color:var(--muted); }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; }
  form { margin:0; }
  button { font:inherit; cursor:pointer; border-radius:8px; padding:10px 16px; border:1px solid var(--border); background:transparent; color:var(--fg); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  footer { margin-top:24px; font-size:.8rem; color:var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(options.heading)}</h1>
${paragraphs}
${actions ? `<div class="actions">${actions}</div>` : ''}
${options.footer ? `<footer>${escapeHtml(options.footer)}</footer>` : ''}
</main>
</body>
</html>`;
}

/** "rahul@example.com" → "ra•••@example.com": enough to recognise, little to leak if forwarded. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const shown = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${shown}${'•'.repeat(Math.max(2, Math.min(6, local.length - shown.length)))}${email.slice(at)}`;
}
