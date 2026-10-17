/**
 * Export the existing application schema and seed updates as ordered D1 SQL
 * migration files. Run locally with Node >=22.18 before using Wrangler.
 *
 * This does NOT apply migrations or modify any Cloudflare database.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrations } from '../src/db/migrations.ts';

const directory = 'migrations';
await mkdir(directory, { recursive: true });
let previous = 0;
for (const migration of migrations) {
  if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
    throw new Error('Migration versions must be positive, strictly increasing integers');
  }
  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(migration.sql)) {
    throw new Error('Explicit transaction statement in migration ' + migration.version);
  }
  const name = String(migration.version).padStart(4, '0') + '_' +
    migration.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.sql';
  await writeFile(join(directory, name), '-- Generated from src/db/migrations.ts. Do not edit directly.\n' +
    migration.sql.trim() + '\n', 'utf8');
  previous = migration.version;
}
console.log('Exported ' + migrations.length + ' D1 migration files to ' + directory + '/');
