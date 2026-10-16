import type { Migration } from 'kysely';
import * as m0001 from './0001_identity';
import * as m0002 from './0002_contacts';
import * as m0003 from './0003_segments';
import * as m0004 from './0004_content';
import * as m0005 from './0005_messaging';
import * as m0006 from './0006_automations';
import * as m0007 from './0007_campaigns';
import * as m0008 from './0008_workflow';

/**
 * Migrations are registered statically (rather than read from disk) so that
 * bundled production builds and the CLI carry them along. Names sort
 * lexicographically and must never be renamed once released.
 */
export const MIGRATIONS: Record<string, Migration> = {
  '0001_identity': m0001,
  '0002_contacts': m0002,
  '0003_segments': m0003,
  '0004_content': m0004,
  '0005_messaging': m0005,
  '0006_automations': m0006,
  '0007_campaigns': m0007,
  '0008_workflow': m0008,
};
