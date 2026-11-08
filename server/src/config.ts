import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .default(def ? 'true' : 'false')
    .transform((v) => (v === '' ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://beacon:beacon@localhost:5432/beacon'),
  JWT_SECRET: z.string().min(16).default('dev-only-insecure-jwt-secret-change-me'),
  ACCESS_TOKEN_TTL_S: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_S: z.coerce.number().int().default(60 * 60 * 24 * 14),
  BACKEND_ENC_PRIVATE_KEY: z.string().optional().default(''),
  BACKEND_SIGN_PRIVATE_KEY: z.string().optional().default(''),
  SENDER_HASH_SALT: z.string().optional().default(''),
  NEMOTRON_BASE_URL: z.string().optional().default(''),
  NEMOTRON_API_KEY: z.string().optional().default(''),
  NEMOTRON_MODEL: z.string().default('nvidia/nemotron'),
  NEMOTRON_TIMEOUT_MS: z.coerce.number().int().default(4000),
  NEMOTRON_ENABLE_THINKING: bool(false),
  INLINE_TRIAGE_BUDGET_MS: z.coerce.number().int().default(3000),
  DEMO_MODE: bool(false),
  SEED_ON_START: bool(true),
  SEED_PASSWORD: z.string().default('beacon-demo'),
  RUN_MIGRATIONS_ON_START: bool(true),
  VALIDATE_RESPONSES: z.enum(['true', 'false', '']).optional().default(''),
  RETENTION_DEFAULT_DAYS: z.coerce.number().int().default(7),
  /** Welfare check-in interval for `normal` tier cases (seconds). `critical` and `high` have their own interval. */
  CHECKIN_INTERVAL_S: z.coerce.number().int().default(1800),
  CHECKIN_INTERVAL_CRITICAL_S: z.coerce.number().int().default(600),
  CHECKIN_INTERVAL_HIGH_S: z.coerce.number().int().default(900),
  /** How long the person has to answer a welfare check-in (deadline_at = sent_at + this). */
  CHECKIN_WINDOW_S: z.coerce.number().int().default(300),
  /** The phone sounds its final-try alarm at deadline_at minus this (alarm_at). */
  CHECKIN_ALARM_LEAD_S: z.coerce.number().int().default(60),
  HEARTBEAT_INTERVAL_S: z.coerce.number().int().default(300),
  SILENCE_THRESHOLD_S: z.coerce.number().int().default(1200),
  SENDER_RATE_PER_HOUR: z.coerce.number().int().default(60),
  LOGIN_RATE_PER_MIN: z.coerce.number().int().default(30),
  DEVICE_REGISTER_RATE_PER_MIN: z.coerce.number().int().default(60),
  IP_RATE_PER_MIN: z.coerce.number().int().default(600),
  HEARTBEAT_RATE_PER_MIN: z.coerce.number().int().default(12),
  CASES_PER_HOUR_FLAG: z.coerce.number().int().default(20),
  VOICE_MAX_BYTES: z.coerce.number().int().default(2 * 1024 * 1024),
  HEALTH_CACHE_S: z.coerce.number().int().default(30),
  JOBS_ENABLED: z.enum(['true', 'false', '']).optional().default(''),
  DEADZONE_QUIET_S: z.coerce.number().int().default(1800),
  DEADZONE_CELL_KM: z.coerce.number().default(1),
  DEADZONE_MIN_ACTIVE_NEIGHBORS: z.coerce.number().int().default(5),
  NEIGHBOR_K: z.coerce.number().int().default(3),
  CHECKIN_MAX_ATTEMPTS: z.coerce.number().int().default(10),
  /** Optional key material for profile encryption at rest (HKDF input). Falls back to JWT_SECRET so existing deployments keep working. */
  PROFILE_ENC_KEY: z.string().optional().default(''),
  PROFILE_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  PROFILE_REQUIRED: bool(true),
  PROFILE_CONSENT_VERSION: z.string().min(1).max(40).default('2026-11-v1'),
  PROFILE_WRITE_RATE_PER_MIN: z.coerce.number().int().default(10),
  /** Optional FCM HTTP v1 push for welfare check-ins. Both must be set to enable it; otherwise a logging no-op provider is used. */
  FCM_PROJECT_ID: z.string().optional().default(''),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
  PUBLIC_DIR: z.string().optional().default(''),
  OPENAPI_PATH: z.string().optional().default(''),
});

export type Config = Omit<z.infer<typeof schema>, 'VALIDATE_RESPONSES' | 'JOBS_ENABLED'> & { validateResponses: boolean; jobsEnabled: boolean };

/** In DEMO_MODE the timers shrink so silence and dead zones show up inside a 3 minute demo (explicit env values still win). */
const DEMO_TIMERS: Record<string, number> = { CHECKIN_INTERVAL_S: 30, CHECKIN_INTERVAL_CRITICAL_S: 20, CHECKIN_INTERVAL_HIGH_S: 25, CHECKIN_WINDOW_S: 30, CHECKIN_ALARM_LEAD_S: 10, SILENCE_THRESHOLD_S: 60, HEARTBEAT_INTERVAL_S: 15, DEADZONE_QUIET_S: 120 };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  const { VALIDATE_RESPONSES, JOBS_ENABLED, ...rest } = parsed.data;
  const cfg = {
    ...rest,
    validateResponses: VALIDATE_RESPONSES ? VALIDATE_RESPONSES === 'true' : rest.NODE_ENV !== 'production',
    jobsEnabled: JOBS_ENABLED ? JOBS_ENABLED === 'true' : rest.NODE_ENV !== 'test',
  };
  if (cfg.DEMO_MODE) for (const [k, v] of Object.entries(DEMO_TIMERS)) if (!env[k]) (cfg as Record<string, unknown>)[k] = v;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (!cfg.BACKEND_ENC_PRIVATE_KEY || !cfg.BACKEND_SIGN_PRIVATE_KEY) {
      throw new Error('BACKEND_ENC_PRIVATE_KEY and BACKEND_SIGN_PRIVATE_KEY must be set in production (npm run keys)');
    }
  }
  return cfg;
}
