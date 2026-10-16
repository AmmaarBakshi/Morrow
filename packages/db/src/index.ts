export * from './schema';
export * from './connection';
export * from './migrate';
export * from './util';
export { MIGRATIONS } from './migrations';
export { sql, type Kysely, type Transaction, type ExpressionBuilder, type SqlBool } from 'kysely';

import type { Kysely, Transaction } from 'kysely';
import type { Database } from './schema';

/** A database handle or an open transaction — services accept either. */
export type Db = Kysely<Database> | Transaction<Database>;
