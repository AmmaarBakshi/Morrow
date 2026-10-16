import { escapeHtml } from './escape';
import { htmlToText, injectPreheader } from './html-to-text';
import { analyzeTemplate, TemplateSyntaxError, type TemplateNode } from './parser';
import { parseCached, renderNodes, type RenderMode } from './render';
import { isKnownVariable } from './variables';

export interface TemplateSource {
  subject: string;
  previewText?: string | null;
  html: string;
  /** Plain-text alternative. Generated from the HTML when omitted. */
  text?: string | null;
}

export interface SnippetSource {
  html: string;
  text?: string | null;
}

export interface ComposeOptions {
  snippets?: Record<string, SnippetSource>;
  fallbacks?: Record<string, string>;
  locale?: string;
}

export interface ComposedEmail {
  subject: string;
  previewText: string;
  html: string;
  text: string;
  missing: string[];
  fallbacksUsed: string[];
  used: string[];
  warnings: string[];
}

function partialResolver(snippets: Record<string, SnippetSource> | undefined, mode: RenderMode, warnings: string[]) {
  return (name: string): TemplateNode[] | null => {
    const snippet = snippets?.[name];
    if (!snippet) return null;
    const source = mode === 'html' ? snippet.html : (snippet.text ?? htmlToText(snippet.html));
    try {
      return parseCached(source);
    } catch (err) {
      warnings.push(`Snippet "${name}" has a syntax error: ${(err as Error).message}`);
      return null;
    }
  };
}

/** Render subject, preview text, HTML and plain text for one recipient. */
export function composeEmail(source: TemplateSource, data: Record<string, unknown>, options: ComposeOptions = {}): ComposedEmail {
  const warnings: string[] = [];
  const base = { fallbacks: options.fallbacks, locale: options.locale };

  const subject = renderNodes(parseCached(source.subject), data, {
    ...base,
    mode: 'subject',
    partial: partialResolver(options.snippets, 'subject', warnings),
  });
  const preview = renderNodes(parseCached(source.previewText ?? ''), data, {
    ...base,
    mode: 'subject',
    partial: partialResolver(options.snippets, 'subject', warnings),
  });
  const html = renderNodes(parseCached(source.html), data, {
    ...base,
    mode: 'html',
    partial: partialResolver(options.snippets, 'html', warnings),
  });
  const textSource = source.text && source.text.trim() ? source.text : htmlToText(source.html);
  const text = renderNodes(parseCached(textSource), data, {
    ...base,
    mode: 'text',
    partial: partialResolver(options.snippets, 'text', warnings),
  });

  const all = [subject, preview, html, text];
  return {
    subject: subject.output,
    previewText: preview.output,
    html: injectPreheader(html.output, preview.output, escapeHtml),
    text: text.output,
    missing: [...new Set(all.flatMap((r) => r.missing))],
    fallbacksUsed: [...new Set(all.flatMap((r) => r.fallbacksUsed))],
    used: [...new Set(all.flatMap((r) => r.used))],
    warnings: [...new Set([...warnings, ...all.flatMap((r) => r.warnings)])],
  };
}

export interface TemplateIssue {
  field: 'subject' | 'previewText' | 'html' | 'text';
  message: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
}

export interface TemplateValidation {
  ok: boolean;
  issues: TemplateIssue[];
  variables: string[];
  /** Variables used without a default; recipients missing them need a fallback. */
  requiredVariables: string[];
  snippets: string[];
}

export interface ValidateOptions {
  snippetNames?: Iterable<string>;
  workspaceVariables?: Iterable<string>;
  customFieldKeys?: Iterable<string>;
  requireUnsubscribe?: boolean;
}

/** Static validation used when saving or publishing a template. */
export function validateTemplateSource(source: TemplateSource, options: ValidateOptions = {}): TemplateValidation {
  const issues: TemplateIssue[] = [];
  const variables = new Map<string, boolean>();
  const snippets = new Set<string>();
  const fields: Array<[TemplateIssue['field'], string]> = [
    ['subject', source.subject],
    ['previewText', source.previewText ?? ''],
    ['html', source.html],
    ['text', source.text ?? ''],
  ];
  for (const [field, value] of fields) {
    try {
      const analysis = analyzeTemplate(parseCached(value));
      for (const v of analysis.variables) {
        const prev = variables.get(v.path);
        variables.set(v.path, prev === undefined ? v.hasDefault : prev && v.hasDefault);
      }
      analysis.partials.forEach((p) => snippets.add(p));
    } catch (err) {
      if (err instanceof TemplateSyntaxError) {
        issues.push({ field, message: err.message, line: err.line, column: err.column, severity: 'error' });
      } else {
        issues.push({ field, message: (err as Error).message, severity: 'error' });
      }
    }
  }
  if (!source.subject.trim()) issues.push({ field: 'subject', message: 'Subject is required.', severity: 'error' });
  if (!source.html.trim()) issues.push({ field: 'html', message: 'HTML content is required.', severity: 'error' });
  if (/\r|\n/.test(source.subject)) issues.push({ field: 'subject', message: 'Subject must be a single line.', severity: 'error' });

  const known = new Set(options.snippetNames ?? []);
  for (const s of snippets) {
    if (!known.has(s)) issues.push({ field: 'html', message: `Snippet "${s}" does not exist.`, severity: 'error' });
  }
  const wsVars = [...(options.workspaceVariables ?? [])];
  const cf = [...(options.customFieldKeys ?? [])];
  for (const v of variables.keys()) {
    if (!isKnownVariable(v, wsVars, cf)) {
      issues.push({ field: 'html', message: `Unknown variable "${v}". Check the spelling or define it in workspace settings.`, severity: 'warning' });
    }
  }
  if (options.requireUnsubscribe && !variables.has('unsubscribe_url')) {
    issues.push({
      field: 'html',
      message: 'Marketing and relationship e-mails need {{unsubscribe_url}}. Morrow will append a standard footer if it is missing.',
      severity: 'warning',
    });
  }
  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    variables: [...variables.keys()],
    requiredVariables: [...variables.entries()].filter(([, hasDefault]) => !hasDefault).map(([k]) => k),
    snippets: [...snippets],
  };
}
