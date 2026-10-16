import { ordinal } from '../time/calendar';
import { escapeHtml, sanitizeHeaderValue, sanitizeUrl } from './escape';
import { parseTemplate, type Condition, type FilterCall, type Literal, type TemplateNode } from './parser';

export type RenderMode = 'html' | 'text' | 'subject';

export interface RenderOptions {
  mode: RenderMode;
  /** Resolve a snippet by name. Return null when it does not exist. */
  partial?: (name: string) => TemplateNode[] | null;
  /** Values used when a variable is missing, e.g. { first_name: 'there' }. */
  fallbacks?: Record<string, string>;
  locale?: string;
  maxPartialDepth?: number;
}

export interface RenderResult {
  output: string;
  /** Variables that were referenced, missing, and had no default or fallback. */
  missing: string[];
  /** Variables whose configured fallback was used. */
  fallbacksUsed: string[];
  used: string[];
  warnings: string[];
}

type Data = Record<string, unknown>;

export function isMissingValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'number') return !Number.isFinite(value);
  return false;
}

export function lookupPath(data: Data, path: string): unknown {
  let cur: unknown = data;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toDisplayString(value: unknown, warnings: string[], path: string): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map((v) => toDisplayString(v, warnings, path)).join(', ');
  warnings.push(`"${path}" is an object and cannot be printed directly`);
  return '';
}

function parseDateish(value: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDate(value: string, style: string, locale: string): string {
  const d = parseDateish(value);
  if (!d) return value;
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
  switch (style) {
    case 'iso':
      return d.toISOString().slice(0, 10);
    case 'short':
      opts.dateStyle = 'short';
      break;
    case 'month_day':
      opts.month = 'long';
      opts.day = 'numeric';
      break;
    case 'month':
      opts.month = 'long';
      break;
    case 'year':
      opts.year = 'numeric';
      break;
    default:
      opts.dateStyle = 'long';
  }
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  }
}

export const FILTER_NAMES = [
  'default',
  'upper',
  'lower',
  'capitalize',
  'title',
  'trim',
  'truncate',
  'date',
  'ordinal',
  'first_word',
] as const;

function applyFilter(value: string, filter: FilterCall, locale: string, warnings: string[]): string {
  const arg = (i: number): Literal | undefined => filter.args[i];
  switch (filter.name) {
    case 'upper':
      return value.toLocaleUpperCase(locale);
    case 'lower':
      return value.toLocaleLowerCase(locale);
    case 'capitalize':
      return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
    case 'title':
      return value.replace(/\S+/g, (w) => w.charAt(0).toLocaleUpperCase(locale) + w.slice(1).toLocaleLowerCase(locale));
    case 'trim':
      return value.trim();
    case 'first_word':
      return value.trim().split(/\s+/)[0] ?? '';
    case 'truncate': {
      const n = typeof arg(0) === 'number' ? (arg(0) as number) : 80;
      const chars = [...value];
      return chars.length > n ? `${chars.slice(0, Math.max(0, n - 1)).join('')}…` : value;
    }
    case 'date':
      return formatDate(value, typeof arg(0) === 'string' ? (arg(0) as string) : 'long', locale);
    case 'ordinal': {
      const n = Number(value);
      return Number.isInteger(n) ? ordinal(n) : value;
    }
    case 'default':
      return value;
    default:
      warnings.push(`Unknown filter "${filter.name}"`);
      return value;
  }
}

function literalToString(lit: Literal | undefined): string {
  if (lit === undefined || lit === null) return '';
  return String(lit);
}

function isTruthy(value: unknown): boolean {
  if (isMissingValue(value)) return false;
  if (value === false || value === 0) return false;
  if (typeof value === 'string' && ['false', 'no', '0'].includes(value.trim().toLowerCase())) return false;
  return true;
}

function evaluateCondition(cond: Condition, data: Data): boolean {
  const value = lookupPath(data, cond.path);
  if (!cond.op) return isTruthy(value);
  let equal: boolean;
  if (typeof cond.value === 'number' && value !== null && value !== '' && Number.isFinite(Number(value))) {
    equal = Number(value) === cond.value;
  } else if (typeof cond.value === 'boolean') {
    equal = isTruthy(value) === cond.value;
  } else if (cond.value === null) {
    equal = isMissingValue(value);
  } else {
    equal = String(value ?? '').trim().toLowerCase() === literalToString(cond.value).trim().toLowerCase();
  }
  return cond.op === '==' ? equal : !equal;
}

/** Attributes whose values are URLs; merge values placed there get scheme checks. */
const URL_CONTEXT_RE = /\s(href|src|action|background|poster|cite|formaction|xlink:href)\s*=\s*(["']?)([^"'<>]*)$/i;

function escapeForContext(value: string, out: string, warnings: string[], path: string): string {
  const tail = out.slice(-512);
  const lastTagOpen = tail.lastIndexOf('<');
  const lastTagClose = tail.lastIndexOf('>');
  const insideTag = lastTagOpen > lastTagClose;
  if (insideTag) {
    const m = URL_CONTEXT_RE.exec(tail.slice(lastTagOpen));
    if (m) {
      const soFar = m[3] ?? '';
      if (soFar.trim() === '') {
        const safe = sanitizeUrl(value);
        if (safe === null) {
          warnings.push(`"${path}" is not a safe link and was replaced with #`);
          return '#';
        }
        return escapeHtml(safe);
      }
      // Part of a larger URL: encode as a URL component.
      return escapeHtml(encodeURIComponent(value));
    }
  }
  return escapeHtml(value);
}

/** Render a parsed template. Never throws for missing data; reports it instead. */
export function renderNodes(nodes: TemplateNode[], data: Data, options: RenderOptions): RenderResult {
  const missing = new Set<string>();
  const fallbacksUsed = new Set<string>();
  const used = new Set<string>();
  const warnings: string[] = [];
  const locale = options.locale || 'en-US';
  const maxDepth = options.maxPartialDepth ?? 4;
  const partialStack: string[] = [];

  const renderList = (list: TemplateNode[], acc: string): string => {
    let out = acc;
    for (const node of list) {
      switch (node.type) {
        case 'text':
          out += node.value;
          break;
        case 'var': {
          used.add(node.path);
          const raw = lookupPath(data, node.path);
          let isMissing = isMissingValue(raw);
          let value = isMissing ? '' : toDisplayString(raw, warnings, node.path);
          for (const filter of node.filters) {
            if (filter.name === 'default') {
              if (isMissing || value.trim() === '') {
                value = literalToString(filter.args[0]);
                isMissing = value.trim() === '';
              }
              continue;
            }
            if (!isMissing) value = applyFilter(value, filter, locale, warnings);
          }
          if (isMissing) {
            const fallback = options.fallbacks?.[node.path];
            if (fallback !== undefined && fallback !== '') {
              value = fallback;
              fallbacksUsed.add(node.path);
            } else {
              missing.add(node.path);
              value = '';
            }
          }
          if (options.mode === 'html') out += escapeForContext(value, out, warnings, node.path);
          else if (options.mode === 'subject') out += sanitizeHeaderValue(value);
          else out += value;
          break;
        }
        case 'if': {
          used.add(node.condition.path);
          const pass = evaluateCondition(node.condition, data) !== node.negate;
          out = renderList(pass ? node.then : node.else, out);
          break;
        }
        case 'partial': {
          if (partialStack.includes(node.name)) {
            warnings.push(`Snippet "${node.name}" includes itself`);
            break;
          }
          if (partialStack.length >= maxDepth) {
            warnings.push(`Snippets are nested too deeply at "${node.name}"`);
            break;
          }
          const resolved = options.partial?.(node.name) ?? null;
          if (!resolved) {
            warnings.push(`Snippet "${node.name}" does not exist`);
            break;
          }
          partialStack.push(node.name);
          out = renderList(resolved, out);
          partialStack.pop();
          break;
        }
      }
    }
    return out;
  };

  let output = renderList(nodes, '');
  if (options.mode === 'subject') output = sanitizeHeaderValue(output);
  return {
    output,
    missing: [...missing],
    fallbacksUsed: [...fallbacksUsed],
    used: [...used],
    warnings: [...new Set(warnings)],
  };
}

const parseCache = new Map<string, TemplateNode[]>();
const PARSE_CACHE_LIMIT = 500;

/** Parse with a small LRU-ish cache. Throws TemplateSyntaxError on invalid input. */
export function parseCached(source: string): TemplateNode[] {
  const hit = parseCache.get(source);
  if (hit) return hit;
  const nodes = parseTemplate(source);
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const first = parseCache.keys().next().value;
    if (first !== undefined) parseCache.delete(first);
  }
  parseCache.set(source, nodes);
  return nodes;
}

export function renderString(source: string, data: Data, options: RenderOptions): RenderResult {
  return renderNodes(parseCached(source), data, options);
}
