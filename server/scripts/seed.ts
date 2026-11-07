import 'dotenv/config';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db';
import { migrate } from '../src/db/migrate';
import { seedResponders, SEED_RESPONDERS } from '../src/services/responders';
import type { Ctx } from '../src/ctx';

(async () => {
  const cfg = loadConfig();
  const dbh = createDb(cfg.DATABASE_URL);
  await migrate(dbh.pool);
  await seedResponders({ cfg, db: dbh.db } as unknown as Ctx);
  console.log(`seeded responders (password: ${cfg.SEED_PASSWORD}): ${SEED_RESPONDERS.map((r) => `${r.username}/${r.role}`).join(', ')}`);
  await dbh.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
