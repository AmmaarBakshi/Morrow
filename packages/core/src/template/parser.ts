/**
 * Parser for Morrow's template language — a small, safe Mustache-like dialect.
 *
 *   {{first_name}}                         escaped variable
 *   {{first_name | default: "there"}}      filters, chained with |
 *   {{#if company}}…{{else}}…{{/if}}       conditional blocks
 *   {{#if relationship_type == "client"}}  simple comparisons (== / !=)
 *   {{#unless unsubscribed}}…{{/unless}}   negated blocks
 *   {{> footer}}                           reusable snippet (partial)
 *   {{! internal note }}                   comment
 *
 * There is intentionally no raw/unescaped output syntax.
 */

export type Literal = string | number | boolean | null;

export interface FilterCall {
  name: string;
  args: Literal[];
}

export interface TextNode {
  type: 'text';
  value: string;
}

export interface VarNode {
  type: 'var';
  path: string;
  filters: FilterCall[];
  index: number;
}

export interface Condition {
  path: string;
  op?: '==' | '!=';
  value?: Literal;
}

export interface IfNode {
  type: 'if';
  negate: boolean;
  condition: Condition;
  then: TemplateNode[];
  else: TemplateNode[];
  index: number;
}

export interface PartialNode {
  type: 'partial';
  name: string;
  index: number;
}

export type TemplateNode = TextNode | VarNode | IfNode | PartialNode;

export class TemplateSyntaxError extends Error {
  readonly index: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, source: string, index: number) {
    const before = source.slice(0, index);
    const line = before.split('\n').length;
    const column = index - before.lastIndexOf('\n');
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'TemplateSyntaxError';
    this.index = index;
    this.line = line;
    this.column = column;
  }
}

export const VARIABLE_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+){0,3}$/;
export const PARTIAL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const FILTER_NAME_RE = /^[a-z_]+$/;

export const MAX_TEMPLATE_LENGTH = 512 * 1024;

/** Split on a separator character, ignoring separators inside quoted strings. */
function splitOutsideQuotes(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      current += ch;
      if (ch === '\\' && i + 1 < input.length) {
        current += input[++i];
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === separator) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error('Unterminated string literal');
  parts.push(current);
  return parts;
}

function parseLiteral(raw: string): Literal {
  const v = raw.trim();
  if (v === '') throw new Error('Missing value');
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    if (v.length < 2) throw new Error('Unterminated string literal');
    return v.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  throw new Error(`Invalid value "${v}" — quote text values`);
}

function parseVariable(expr: string): { path: string; filters: FilterCall[] } {
  const [head, ...rest] = splitOutsideQuotes(expr, '|');
  const path = head!.trim();
  if (!VARIABLE_PATH_RE.test(path)) throw new Error(`Invalid variable name "${path}"`);
  const filters: FilterCall[] = rest.map((segment) => {
    const colon = segment.indexOf(':');
    const name = (colon === -1 ? segment : segment.slice(0, colon)).trim();
    if (!FILTER_NAME_RE.test(name)) throw new Error(`Invalid filter "${name}"`);
    const argText = colon === -1 ? '' : segment.slice(colon + 1);
    const args = argText.trim() === '' ? [] : splitOutsideQuotes(argText, ',').map(parseLiteral);
    return { name, args };
  });
  return { path, filters };
}

function parseCondition(expr: string): Condition {
  const m = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(==|!=)\s*(.+)$/.exec(expr.trim());
  if (m) {
    if (!VARIABLE_PATH_RE.test(m[1]!)) throw new Error(`Invalid variable name "${m[1]}"`);
    return { path: m[1]!, op: m[2] as '==' | '!=', value: parseLiteral(m[3]!) };
  }
  const path = expr.trim();
  if (!VARIABLE_PATH_RE.test(path)) throw new Error(`Invalid condition "${path}"`);
  return { path };
}

interface OpenBlock {
  node: IfNode;
  kind: 'if' | 'unless';
  inElse: boolean;
}

export function parseTemplate(source: string): TemplateNode[] {
  if (source.length > MAX_TEMPLATE_LENGTH) {
    throw new TemplateSyntaxError('Template is too large', source, 0);
  }
  const root: TemplateNode[] = [];
  const stack: OpenBlock[] = [];
  const target = (): TemplateNode[] => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.inElse ? top.node.else : top.node.then;
  };
  const pushText = (value: string) => {
    if (!value) return;
    const list = target();
    const last = list[list.length - 1];
    if (last && last.type === 'text') last.value += value;
    else list.push({ type: 'text', value });
  };

  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{{', i);
    if (open === -1) {
      pushText(source.slice(i));
      break;
    }
    pushText(source.slice(i, open));
    const close = source.indexOf('}}', open + 2);
    if (close === -1) throw new TemplateSyntaxError('Unclosed tag: expected "}}"', source, open);
    const inner = source.slice(open + 2, close);
    if (inner.startsWith('{')) {
      throw new TemplateSyntaxError('Raw output ({{{…}}}) is not supported; values are always escaped', source, open);
    }
    const tag = inner.trim();
    i = close + 2;

    try {
      if (tag === '') throw new Error('Empty tag');
      if (tag.startsWith('!')) continue;

      if (tag.startsWith('#if ') || tag.startsWith('#unless ')) {
        const kind = tag.startsWith('#if ') ? 'if' : 'unless';
        const node: IfNode = {
          type: 'if',
          negate: kind === 'unless',
          condition: parseCondition(tag.slice(kind === 'if' ? 4 : 8)),
          then: [],
          else: [],
          index: open,
        };
        target().push(node);
        stack.push({ node, kind, inElse: false });
        continue;
      }
      if (tag === 'else') {
        const top = stack[stack.length - 1];
        if (!top) throw new Error('{{else}} without a matching {{#if}}');
        if (top.inElse) throw new Error('Duplicate {{else}}');
        top.inElse = true;
        continue;
      }
      if (tag === '/if' || tag === '/unless') {
        const top = stack.pop();
        if (!top) throw new Error(`{{${tag}}} without a matching block`);
        if (`/${top.kind}` !== tag) throw new Error(`Expected {{/${top.kind}}} but found {{${tag}}}`);
        continue;
      }
      if (tag.startsWith('>')) {
        const name = tag.slice(1).trim();
        if (!PARTIAL_NAME_RE.test(name)) throw new Error(`Invalid snippet name "${name}"`);
        target().push({ type: 'partial', name, index: open });
        continue;
      }
      if (tag.startsWith('#') || tag.startsWith('/')) throw new Error(`Unknown block "${tag}"`);

      const { path, filters } = parseVariable(tag);
      target().push({ type: 'var', path, filters, index: open });
    } catch (err) {
      if (err instanceof TemplateSyntaxError) throw err;
      throw new TemplateSyntaxError((err as Error).message, source, open);
    }
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw new TemplateSyntaxError(`Unclosed {{#${unclosed.kind}}} block`, source, unclosed.node.index);
  }
  return root;
}

export interface VariableUsage {
  path: string;
  /** True when every use has a `default` filter, so absence is never visible. */
  hasDefault: boolean;
  inCondition: boolean;
}

/** Variables and snippets referenced by a template (does not descend into partials). */
export function analyzeTemplate(nodes: TemplateNode[]): { variables: VariableUsage[]; partials: string[] } {
  const vars = new Map<string, VariableUsage>();
  const partials = new Set<string>();
  const visit = (list: TemplateNode[]) => {
    for (const node of list) {
      if (node.type === 'var') {
        const hasDefault = node.filters.some((f) => f.name === 'default');
        const prev = vars.get(node.path);
        if (prev) prev.hasDefault = prev.hasDefault && hasDefault;
        else vars.set(node.path, { path: node.path, hasDefault, inCondition: false });
      } else if (node.type === 'if') {
        if (!vars.has(node.condition.path)) {
          vars.set(node.condition.path, { path: node.condition.path, hasDefault: true, inCondition: true });
        }
        visit(node.then);
        visit(node.else);
      } else if (node.type === 'partial') {
        partials.add(node.name);
      }
    }
  };
  visit(nodes);
  return { variables: [...vars.values()], partials: [...partials] };
}
