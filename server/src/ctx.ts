import type { Kysely } from 'kysely';
import type { Pool } from 'pg';
import type { Config } from './config';
import type { Database } from './db/types';
import type { Logger } from './logger';
import type { Publisher } from './ws/hub';
import type { BackendKeys } from './crypto/keys';
import type { TriageLlm } from './llm/nemotron';
import type { TokenBuckets } from './domain/rateLimit';
import type { KeyObject } from 'node:crypto';

export interface DeviceAuth { id: string; publicKey: KeyObject; senderHash: string; flagged: boolean }

/** Shared dependencies handed to every service (no globals, so tests can build isolated apps). */
export interface Ctx {
  cfg: Config;
  db: Kysely<Database>;
  pool: Pool;
  log: Logger;
  hub: Publisher;
  keys: BackendKeys;
  llm: TriageLlm;
  limiters: { login: TokenBuckets; register: TokenBuckets; sender: TokenBuckets; heartbeat: TokenBuckets; ip: TokenBuckets };
  /** small TTL cache (health ping, mesh stats) */
  cache: Map<string, { at: number; v: unknown }>;
  deviceCache: Map<string, DeviceAuth>;
  /** background work (LLM enrichment, dedupe); `idle()` lets tests wait for it */
  track<T>(p: Promise<T>): void;
  idle(): Promise<void>;
  /** serialises dedupe across processes (Postgres advisory lock) so two simultaneous ingests cannot both miss each other */
  dedupeLock<T>(fn: () => Promise<T>): Promise<T>;
}
