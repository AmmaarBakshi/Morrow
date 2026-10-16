/** Small helpers shared by every repository/service working with the schema. */

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Parse JSON stored as text, returning `fallback` for null or corrupt values. */
export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export const toBool = (value: number | boolean | null | undefined): boolean => value === true || value === 1;
export const fromBool = (value: boolean | null | undefined): number => (value ? 1 : 0);

/**
 * True when an error is a unique-constraint violation on SQLite or PostgreSQL.
 * Used to turn races ("someone created it first") into clean conflicts.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true; // PostgreSQL unique_violation
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  const message = String((err as { message?: unknown }).message ?? '');
  return /UNIQUE constraint failed|duplicate key value violates unique constraint/i.test(message);
}

export function isForeignKeyViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23503' || code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return true;
  return /FOREIGN KEY constraint failed|violates foreign key constraint/i.test(String((err as { message?: unknown }).message ?? ''));
}

/** Escape LIKE wildcards; use with `escape '\\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Split an array into chunks (bounded batch sizes for IN lists and inserts). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
