import 'dotenv/config';
import { loadConfig } from './config';
import { createApp } from './app';

async function main() {
  const cfg = loadConfig();
  const b = await createApp(cfg);
  await new Promise<void>((r) => b.server.listen(cfg.PORT, r));
  b.ctx.log.info({ port: cfg.PORT, llm: b.ctx.llm.model }, 'Beacon server listening');
  const stop = async (sig: string) => {
    b.ctx.log.info({ sig }, 'shutting down');
    await b.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}
main().catch((e) => { console.error(e); process.exit(1); });
