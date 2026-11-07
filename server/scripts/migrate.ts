import 'dotenv/config';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db';
import { migrate } from '../src/db/migrate';

(async () => {
  const cfg = loadConfig();
  const { pool, close } = createDb(cfg.DATABASE_URL);
  const applied = await migrate(pool, (m) => console.log(m));
  console.log(applied.length ? `migrated (${applied.length} applied)` : 'already up to date');
  await close();
})().catch((e) => { console.error(e.message); process.exit(1); });
