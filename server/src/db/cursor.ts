import { sql, type RawBuilder } from 'kysely';
import { invalid } from '../errors';

export interface SortKey { expr: string; dir: 'asc' | 'desc'; cast: 'timestamptz' | 'int' | 'boolean' | 'uuid' }

export const encodeCursor = (sort: string, values: (string | number | boolean)[]) =>
  Buffer.from(JSON.stringify({ s: sort, v: values })).toString('base64url');

export function decodeCursor(cursor: string, sort: string, n: number): (string | number | boolean)[] {
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (o.s === sort && Array.isArray(o.v) && o.v.length === n) return o.v;
  } catch { /* fallthrough */ }
  throw invalid('Invalid cursor', { cursor: 'invalid or issued for a different sort' });
}

/** Keyset predicate "strictly after the cursor row" for a mixed-direction ORDER BY. */
export function keysetWhere(keys: SortKey[], values: (string | number | boolean)[]): RawBuilder<boolean> {
  const ors: RawBuilder<unknown>[] = [];
  for (let i = 0; i < keys.length; i++) {
    const parts: RawBuilder<unknown>[] = [];
    for (let j = 0; j < i; j++) parts.push(sql`${sql.raw(keys[j].expr)} = ${values[j]}::${sql.raw(keys[j].cast)}`);
    const op = keys[i].dir === 'asc' ? sql.raw('>') : sql.raw('<');
    parts.push(sql`${sql.raw(keys[i].expr)} ${op} ${values[i]}::${sql.raw(keys[i].cast)}`);
    ors.push(sql`(${sql.join(parts, sql` and `)})`);
  }
  return sql<boolean>`(${sql.join(ors, sql` or `)})`;
}

export const orderSql = (keys: SortKey[]) => sql.raw(keys.map((k) => `${k.expr} ${k.dir}`).join(', '));
