import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

/** Minimal forward-only SQL migration runner (files in ./migrations, applied in name order, tracked in schema_migrations). */
export async function migrate(pool: Pool, log: (msg: string) => void = () => {}): Promise<string[]> {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
      log(`applied ${f}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  return applied;
}
