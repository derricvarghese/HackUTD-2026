import pino from 'pino';
import type { Config } from './config';

/** Logs never contain note text, coordinates or keys: only ids, counts, reasons. */
export function makeLogger(cfg: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>) {
  return pino({
    level: cfg.NODE_ENV === 'test' ? 'silent' : cfg.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers["x-device-signature"]', '*.password', '*.refresh_token', '*.public_key',
      // profiles are personal data and are never logged on purpose; this is defence in depth against an accidental `log.info({ profile })`
      '*.full_name', '*.preferred_name', '*.birth_year', '*.phone', '*.home_address', '*.medical', '*.mobility', '*.emergency_contact', '*.appearance', '*.household', '*.notes', '*.profile', '*.profile_summary'],
    ...(cfg.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
export type Logger = ReturnType<typeof makeLogger>;
