import pg from 'pg';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://beacon:beacon@localhost:5432/beacon_test';

/** Creates the throwaway test database if needed (the schema is migrated by the app on boot). */
export default async function setup() {
  const u = new URL(TEST_DB_URL);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: u.toString() });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`Cannot reach Postgres for tests (${(e as Error).message}). Run: docker compose up -d db`);
  }
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
  if (!rowCount) await admin.query(`create database ${name.replace(/[^a-z0-9_]/gi, '')}`);
  await admin.end();
}
