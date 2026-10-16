import { describe, expect, it } from 'vitest';
import {
  analyzeTemplate,
  composeEmail,
  htmlToText,
  parseTemplate,
  renderString,
  sanitizeTemplateHtml,
  sanitizeUrl,
  TemplateSyntaxError,
  validateTemplateSource,
} from '../src/template';

const html = (src: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  renderString(src, data, { mode: 'html', ...extra });

describe('template parser', () => {
  it('parses variables, filters, blocks, partials and comments', () => {
    const nodes = parseTemplate('Hi {{ first_name | default: "there" }}{{! note }}{{#if company}} from {{company}}{{else}}!{{/if}}{{> footer}}');
    const analysis = analyzeTemplate(nodes);
    expect(analysis.variables.map((v) => v.path).sort()).toEqual(['company', 'first_name']);
    expect(analysis.variables.find((v) => v.path === 'first_name')?.hasDefault).toBe(true);
    expect(analysis.partials).toEqual(['footer']);
  });

  it('reports syntax errors with line and column', () => {
    expect(() => parseTemplate('Hello\n{{#if x}} oops')).toThrow(TemplateSyntaxError);
    try {
      parseTemplate('Hello\n  {{ bad name }}');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateSyntaxError);
      expect((err as TemplateSyntaxError).line).toBe(2);
      expect((err as TemplateSyntaxError).column).toBe(3);
    }
    expect(() => parseTemplate('{{#if a}}x{{/unless}}')).toThrow(/Expected/);
    expect(() => parseTemplate('{{else}}')).toThrow(/without a matching/);
    expect(() => parseTemplate('{{ name')).toThrow(/Unclosed tag/);
  });

  it('rejects raw (unescaped) output syntax', () => {
    expect(() => parseTemplate('{{{ first_name }}}')).toThrow(/not supported/);
  });
});

describe('template rendering', () => {
  it('escapes HTML in merge values', () => {
    const r = html('<p>Hello {{first_name}}</p>', { first_name: '<script>alert(1)</script>' });
    expect(r.output).toBe('<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('escapes quotes so values cannot break out of attributes', () => {
    const r = html('<img alt="{{company}}">', { company: '" onerror="alert(1)' });
    expect(r.output).toBe('<img alt="&quot; onerror=&quot;alert(1)">');
  });

  it('blocks javascript: URLs in link context', () => {
    const r = html('<a href="{{collaboration_url}}">Join</a>', { collaboration_url: 'javascript:alert(1)' });
    expect(r.output).toBe('<a href="#">Join</a>');
    expect(r.warnings[0]).toMatch(/not a safe link/);
    const encoded = html('<a href="{{u}}">x</a>', { u: 'jav&#x09;ascript:alert(1)' });
    expect(encoded.output).toBe('<a href="#">x</a>');
  });

  it('allows safe URLs and encodes values used inside URLs', () => {
    expect(html('<a href="{{u}}">x</a>', { u: 'https://cyphen.dev/collab?a=1&b=2' }).output).toBe(
      '<a href="https://cyphen.dev/collab?a=1&amp;b=2">x</a>',
    );
    expect(html('<a href="https://x.dev/r?name={{first_name}}">x</a>', { first_name: 'A&B c' }).output).toBe(
      '<a href="https://x.dev/r?name=A%26B%20c">x</a>',
    );
    expect(sanitizeUrl('cyphen.dev/work')).toBe('https://cyphen.dev/work');
    expect(sanitizeUrl('data:text/html,<script>')).toBeNull();
  });

  it('uses the configured fallback when first_name is missing', () => {
    const r = html('Hi {{first_name}},', { first_name: '  ' }, { fallbacks: { first_name: 'there' } });
    expect(r.output).toBe('Hi there,');
    expect(r.fallbacksUsed).toEqual(['first_name']);
    expect(r.missing).toEqual([]);
  });

  it('reports missing variables instead of printing placeholders', () => {
    const r = html('Hi {{first_name}} at {{company}}', {});
    expect(r.output).toBe('Hi  at ');
    expect(r.missing.sort()).toEqual(['company', 'first_name']);
  });

  it('applies the default filter and other filters', () => {
    expect(html('{{company | default: "your team"}}', {}).output).toBe('your team');
    expect(html('{{first_name | upper}}', { first_name: 'rahul' }).output).toBe('RAHUL');
    expect(html('{{name | title}}', { name: 'rAHUL mEHTA' }).output).toBe('Rahul Mehta');
    expect(html('{{years | ordinal}}', { years: 3 }).output).toBe('3rd');
    expect(html('{{d | date: "month_day"}}', { d: '2026-03-07' }, { locale: 'en-GB' }).output).toBe('7 March');
    expect(html('{{t | truncate: 5}}', { t: 'abcdefgh' }).output).toBe('abcd…');
  });

  it('evaluates conditional blocks and comparisons', () => {
    const src = '{{#if relationship_type == "client"}}Thanks for working with us{{else}}Hello{{/if}}';
    expect(html(src, { relationship_type: 'Client' }).output).toBe('Thanks for working with us');
    expect(html(src, { relationship_type: 'lead' }).output).toBe('Hello');
    expect(html('{{#unless company}}No company{{/unless}}', {}).output).toBe('No company');
    expect(html('{{#if years != 1}}s{{/if}}', { years: 3 }).output).toBe('s');
    expect(html('{{#if flag}}on{{else}}off{{/if}}', { flag: 'false' }).output).toBe('off');
  });

  it('does not count variables used only in conditions as missing', () => {
    expect(html('{{#if company}}{{company}}{{/if}}', {}).missing).toEqual([]);
  });

  it('renders partials and guards against recursion', () => {
    const partials: Record<string, string> = { footer: '<p>{{company_name}}</p>', loop: '{{> loop}}' };
    const resolve = (name: string) => (partials[name] ? parseTemplate(partials[name]!) : null);
    expect(html('x{{> footer}}', { company_name: 'Cyphen' }, { partial: resolve }).output).toBe('x<p>Cyphen</p>');
    const r = html('{{> loop}}', {}, { partial: resolve });
    expect(r.warnings.some((w) => w.includes('includes itself'))).toBe(true);
    expect(html('{{> nope}}', {}, { partial: resolve }).warnings[0]).toMatch(/does not exist/);
  });

  it('strips CR/LF from subject lines to prevent header injection', () => {
    const r = renderString('Happy birthday {{first_name}}', { first_name: 'Rahul\r\nBcc: victim@example.com' }, { mode: 'subject' });
    expect(r.output).toBe('Happy birthday Rahul Bcc: victim@example.com');
    expect(r.output).not.toMatch(/[\r\n]/);
  });

  it('does not read inherited object properties', () => {
    expect(html('{{constructor}}', {}).output).toBe('');
    expect(html('{{custom.toString}}', { custom: {} }).output).toBe('');
  });
});

describe('composeEmail', () => {
  it('renders all parts and generates plain text when missing', () => {
    const out = composeEmail(
      {
        subject: 'Happy birthday, {{first_name}}!',
        previewText: 'A note from {{company_name}}',
        html: '<html><body><h1>Happy birthday {{first_name}}</h1><p>From all of us at <a href="{{website_url}}">{{company_name}}</a></p>{{> signature}}</body></html>',
      },
      { first_name: 'Rahul', company_name: 'Cyphen', website_url: 'https://cyphen.dev' },
      { snippets: { signature: { html: '<p>— {{sender_name | default: "The team"}}</p>' } } },
    );
    expect(out.subject).toBe('Happy birthday, Rahul!');
    expect(out.html).toContain('A note from Cyphen');
    expect(out.html).toContain('display:none');
    expect(out.text).toContain('Happy birthday Rahul');
    expect(out.text).toContain('Cyphen (https://cyphen.dev)');
    expect(out.text).toContain('— The team');
    expect(out.missing).toEqual([]);
  });
});

describe('validateTemplateSource', () => {
  it('flags syntax errors, unknown snippets, unknown variables and missing unsubscribe', () => {
    const v = validateTemplateSource(
      { subject: 'Hi {{first_name}}', html: '<p>{{frist_name}}</p>{{> footer}}{{#if x}}' },
      { snippetNames: [], requireUnsubscribe: true },
    );
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.message.includes('Unclosed'))).toBe(true);

    const v2 = validateTemplateSource(
      { subject: 'Hi {{first_name}}', html: '<p>{{frist_name}}</p>{{> footer}}' },
      { snippetNames: [], requireUnsubscribe: true },
    );
    expect(v2.issues.map((i) => i.message).join('\n')).toMatch(/Snippet "footer" does not exist/);
    expect(v2.issues.map((i) => i.message).join('\n')).toMatch(/Unknown variable "frist_name"/);
    expect(v2.issues.map((i) => i.message).join('\n')).toMatch(/unsubscribe_url/);
    expect(v2.requiredVariables.sort()).toEqual(['first_name', 'frist_name']);
  });

  it('accepts custom fields, workspace variables and event properties', () => {
    const v = validateTemplateSource(
      { subject: '{{custom.plan}} {{release_name}} {{event.project_name}}', html: '<p>{{unsubscribe_url}}</p>' },
      { customFieldKeys: ['plan'], workspaceVariables: ['release_name'], requireUnsubscribe: true },
    );
    expect(v.issues).toEqual([]);
  });
});

describe('sanitizeTemplateHtml', () => {
  it('removes scripts, frames and event handlers but keeps e-mail markup', () => {
    const { html: out, removed } = sanitizeTemplateHtml(
      '<table width="600"><tr><td style="color:#333" onclick="steal()">Hi {{first_name}}</td></tr></table><script>alert(1)</script><iframe src="x"></iframe>',
    );
    expect(out).toBe('<table width="600"><tr><td style="color:#333">Hi {{first_name}}</td></tr></table>');
    expect(removed).toEqual(expect.arrayContaining(['onclick attribute', '<script>', '<iframe>']));
  });

  it('removes javascript: and data: URLs but preserves template tags in attributes', () => {
    const { html: out } = sanitizeTemplateHtml(
      '<a href="javascript:alert(1)">bad</a><a href="{{unsubscribe_url}}">Unsubscribe</a><img src="data:text/html;base64,xx"><a href="JaVa&#x53;cript:x">e</a>',
    );
    expect(out).toBe('<a>bad</a><a href="{{unsubscribe_url}}">Unsubscribe</a><img><a>e</a>');
  });

  it('keeps Outlook conditional comments and cleans dangerous CSS', () => {
    const { html: out } = sanitizeTemplateHtml(
      '<!--[if mso]><table><tr><td><![endif]--><style>@import url(evil.css); p{color:red;width:expression(alert(1))}</style><div style="background:url(javascript:alert(1))">x</div>',
    );
    expect(out).toContain('<!--[if mso]>');
    expect(out).not.toMatch(/expression\(|@import|javascript:/i);
  });

  it('preserves template blocks inside tags', () => {
    const src = '<td {{#if vip}}class="vip"{{/if}} align="left">{{#if vip}}VIP{{/if}}</td>';
    // Attribute whitespace is normalised; the template tags survive intact.
    expect(sanitizeTemplateHtml(src).html).toBe('<td {{#if vip}} class="vip" {{/if}} align="left">{{#if vip}}VIP{{/if}}</td>');
  });

  it('drops meta refresh and non-stylesheet links', () => {
    const { html: out } = sanitizeTemplateHtml(
      '<meta charset="utf-8"><meta http-equiv="refresh" content="0;url=x"><link rel="stylesheet" href="https://fonts.example/a.css"><link rel="import" href="x">',
    );
    expect(out).toBe('<meta charset="utf-8"><link rel="stylesheet" href="https://fonts.example/a.css">');
  });
});

describe('htmlToText', () => {
  it('produces readable text', () => {
    const text = htmlToText(
      '<html><head><style>p{}</style></head><body><h1>Hello&nbsp;Rahul</h1><p>Line one<br>Line two</p><ul><li>One</li><li>Two</li></ul><a href="https://x.dev">Visit</a></body></html>',
    );
    expect(text).toBe('Hello Rahul\n\nLine one\nLine two\n\n- One\n- Two\nVisit (https://x.dev)');
  });
});
