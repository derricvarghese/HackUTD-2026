import type { Kysely } from 'kysely';
import type { Pool } from 'pg';
import type { Config } from './config';
import type { Database } from './db/types';
import type { Logger } from './logger';
import type { Publisher } from './ws/hub';
import type { BackendKeys } from './crypto/keys';
import type { TriageLlm } from './llm/nemotron';
import type { TokenBuckets } from './domain/rateLimit';
import type { PushProvider } from './services/push';
import type { AiTriage } from './services/aiTriage';
import type { AgentRunner } from './agent/runner';
import type { FacilitiesService } from './agent/facilities';
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
  /** notification delivery for welfare check-ins (noop unless FCM is configured) */
  push: PushProvider;
  limiters: { login: TokenBuckets; register: TokenBuckets; sender: TokenBuckets; heartbeat: TokenBuckets; profile: TokenBuckets; image: TokenBuckets; ip: TokenBuckets };
  /** small TTL cache (health ping, mesh stats) */
  cache: Map<string, { at: number; v: unknown }>;
  deviceCache: Map<string, DeviceAuth>;
  /** background work (LLM enrichment, dedupe); `idle()` lets tests wait for it */
  track<T>(p: Promise<T>): void;
  idle(): Promise<void>;
  /** asynchronous LLM triage queue (provisional rules score first, AI result later) */
  aiTriage: AiTriage;
  /** dispatch agent: tool-calling Nemotron loop that proposes a dispatch for human approval */
  agent: AgentRunner;
  /** background Overpass ingestion of hospitals and fire stations per event */
  facilities: FacilitiesService;
  /** outbound HTTP for the agent's external tools (tests inject a fake); defaults to global fetch */
  fetch?: typeof fetch;
  /** serialises dedupe across processes (Postgres advisory lock) so two simultaneous ingests cannot both miss each other */
  dedupeLock<T>(fn: () => Promise<T>): Promise<T>;
}
