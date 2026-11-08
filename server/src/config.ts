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
  /** AI triage runs after the case is stored and shown with its rules score; these knobs shape that background pipeline. */
  AI_TRIAGE_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  /** Attempts per round before a case is marked `failed` (null/timeout/invalid output each count as one). */
  AI_TRIAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  /** Delay before attempt 2, 3, ... in ms (comma list; the last value repeats). */
  AI_TRIAGE_BACKOFF_MS: z.string().default('2000,8000,30000').transform((v) => v.split(',').map((x) => Math.max(0, Number(x.trim()) || 0))),
  /** Slow-sweep cadence for recovery and for re-trying `failed` cases, how long a failed case waits between rounds, and how many rounds it gets. */
  AI_TRIAGE_SWEEP_S: z.coerce.number().int().min(1).default(30),
  AI_TRIAGE_FAILED_RETRY_S: z.coerce.number().int().min(1).default(300),
  AI_TRIAGE_FAILED_MAX_SWEEPS: z.coerce.number().int().min(0).default(6),
  /** Cases whose AI pass was requested longer ago than this are left alone by the sweep. */
  AI_TRIAGE_MAX_AGE_H: z.coerce.number().min(0).default(24),
  /** How often a job re-checks the LLM circuit breaker while it is open (jobs wait, attempts are not burned). */
  AI_TRIAGE_BREAKER_WAIT_MS: z.coerce.number().int().min(0).default(5000),
  /** Artificial latency for the offline StubLlm so the provisional -> final transition is visible. Defaults to 1500 in DEMO_MODE, else 0. */
  AI_TRIAGE_DEMO_DELAY_MS: z.coerce.number().int().min(0).default(0),
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
  /** An unanswered (overdue) check-in is re-delivered every this many seconds; after 12 reminders every CHECKIN_REMINDER_SLOW_S. */
  CHECKIN_REMINDER_S: z.coerce.number().int().min(1).default(300),
  CHECKIN_REMINDER_SLOW_S: z.coerce.number().int().min(1).default(900),
  HEARTBEAT_INTERVAL_S: z.coerce.number().int().default(300),
  SILENCE_THRESHOLD_S: z.coerce.number().int().default(1200),
  SENDER_RATE_PER_HOUR: z.coerce.number().int().default(60),
  LOGIN_RATE_PER_MIN: z.coerce.number().int().default(30),
  DEVICE_REGISTER_RATE_PER_MIN: z.coerce.number().int().default(60),
  IP_RATE_PER_MIN: z.coerce.number().int().default(600),
  HEARTBEAT_RATE_PER_MIN: z.coerce.number().int().default(12),
  CASES_PER_HOUR_FLAG: z.coerce.number().int().default(20),
  VOICE_MAX_BYTES: z.coerce.number().int().default(2 * 1024 * 1024),
  IMAGE_MAX_BYTES: z.coerce.number().int().default(3 * 1024 * 1024),
  IMAGE_MAX_PER_CASE: z.coerce.number().int().min(1).default(6),
  IMAGE_UPLOAD_RATE_PER_MIN: z.coerce.number().int().default(20),
  HEALTH_CACHE_S: z.coerce.number().int().default(30),
  JOBS_ENABLED: z.enum(['true', 'false', '']).optional().default(''),
  DEADZONE_QUIET_S: z.coerce.number().int().default(1800),
  DEADZONE_CELL_KM: z.coerce.number().default(1),
  DEADZONE_MIN_ACTIVE_NEIGHBORS: z.coerce.number().int().default(5),
  NEIGHBOR_K: z.coerce.number().int().default(3),
  /** Unused since overdue check-ins are re-delivered instead of re-created; kept so existing env files still parse. */
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
const DEMO_TIMERS: Record<string, number> = { CHECKIN_INTERVAL_S: 30, CHECKIN_INTERVAL_CRITICAL_S: 20, CHECKIN_INTERVAL_HIGH_S: 25, CHECKIN_WINDOW_S: 30, CHECKIN_REMINDER_S: 20, CHECKIN_REMINDER_SLOW_S: 60, SILENCE_THRESHOLD_S: 60, HEARTBEAT_INTERVAL_S: 15, DEADZONE_QUIET_S: 120 };

/** Tests must not sleep through production backoffs. Explicit env values still win. */
const TEST_DEFAULTS: Record<string, string> = { AI_TRIAGE_BACKOFF_MS: '20,20,20', AI_TRIAGE_BREAKER_WAIT_MS: '50', AI_TRIAGE_DEMO_DELAY_MS: '0' };

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const env = rawEnv.NODE_ENV === 'test' ? { ...TEST_DEFAULTS, ...rawEnv } : rawEnv;
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
  if (cfg.DEMO_MODE && !env.AI_TRIAGE_DEMO_DELAY_MS) cfg.AI_TRIAGE_DEMO_DELAY_MS = 1500;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (!cfg.BACKEND_ENC_PRIVATE_KEY || !cfg.BACKEND_SIGN_PRIVATE_KEY) {
      throw new Error('BACKEND_ENC_PRIVATE_KEY and BACKEND_SIGN_PRIVATE_KEY must be set in production (npm run keys)');
    }
  }
  return cfg;
}
