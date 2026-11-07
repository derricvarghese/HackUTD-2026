import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types';

// bigint (count) -> number
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export interface Db {
  pool: pg.Pool;
  db: Kysely<Database>;
  close(): Promise<void>;
}

export function createDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { pool, db, close: () => db.destroy() };
}
