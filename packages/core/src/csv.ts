/**
 * RFC 4180 CSV parsing and safe CSV generation.
 */

export type Delimiter = ',' | ';' | '\t';

/** Guess the delimiter from the header line. */
export function detectDelimiter(text: string): Delimiter {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++;
  }
  const best = (Object.entries(counts) as Array<[Delimiter, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

export interface ParseCsvOptions {
  delimiter?: Delimiter;
  /** Stop after this many records (including the header). */
  maxRecords?: number;
}

export interface ParsedCsv {
  rows: string[][];
  delimiter: Delimiter;
  truncated: boolean;
}

export function parseCsv(input: string, options: ParseCsvOptions = {}): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const max = options.maxRecords ?? Number.POSITIVE_INFINITY;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  let truncated = false;
  const n = text.length;

  const endRow = () => {
    row.push(field);
    field = '';
    // Skip completely empty lines.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (rows.length >= max) {
        truncated = i < n;
        return { rows, delimiter, truncated };
      }
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  return { rows, delimiter, truncated };
}

/**
 * Neutralise spreadsheet formula injection: cells beginning with = + - @ (or
 * a tab/CR) are prefixed with an apostrophe, except plain negative numbers.
 */
export function neutralizeCsvCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value) && !/^-?\d+([.,]\d+)?$/.test(value)) return `'${value}`;
  return value;
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>, delimiter: Delimiter = ','): string {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            if (cell === null || cell === undefined) return '';
            const raw = typeof cell === 'string' ? neutralizeCsvCell(cell) : String(cell);
            return /["\r\n]/.test(raw) || raw.includes(delimiter) ? `"${raw.replace(/"/g, '""')}"` : raw;
          })
          .join(delimiter),
      )
      .join('\r\n') + '\r\n'
  );
}
