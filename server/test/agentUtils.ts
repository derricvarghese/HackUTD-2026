import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage, LlmInput, LlmResult, ToolCall, ToolChatRequest, ToolChatResult, TriageLlm } from '../src/llm/nemotron';
import type { TestEnv } from './helpers';
import type { TestDevice } from '../src/testing/envelope';
import { uuidv7 } from '../src/testing/uuid';

export const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/agent', name), 'utf8'));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const until = async (fn: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  throw new Error('condition not met in time');
};
export const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

export const EXACT = { lat: 32.776712, lng: -96.797034 };
export const PII = ['Maria', 'Gonzalez', 'Elena', '972555', 'Cedar', 'Richardson', 'Daniel', 'green pot', 'cardigan'];
/** any decimal with 4+ fraction digits looks like a precise coordinate */
export const PRECISE = /-?\d{1,3}\.\d{4,}/;

export const call = (name: string, args: unknown = {}, id = `call_${name}_${Math.random().toString(36).slice(2, 7)}`): ToolCall => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
export const msg = (content: string | null, calls: ToolCall[] = []) => ({ content, ...(calls.length ? { tool_calls: calls } : {}) });

export type Script = (req: ToolChatRequest, turn: number) => ToolChatResult['message'] | null | Promise<ToolChatResult['message'] | null>;

/** Fake LLM: scripted tool-calling turns, deterministic extraction. Records every request. */
export class ScriptedLlm implements TriageLlm {
  readonly model = 'fake-agent-llm';
  requests: ToolChatRequest[] = [];
  extractDelta = 0;
  inflight = 0;
  maxInflight = 0;
  up = true;
  constructor(public script: Script) {}
  async extract(_i: LlmInput): Promise<LlmResult | null> {
    return { model: this.model, extraction: { vulnerable: [], medical: [], hazards: [], urgency_delta: this.extractDelta, reasons: ['fake extraction'], confidence: 'high' } };
  }
  async chatTools(req: ToolChatRequest): Promise<ToolChatResult | null> {
    this.requests.push(structuredClone(req));
    this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      const m = await this.script(req, this.requests.length);
      return m ? { message: m, model: this.model, usage: { prompt_tokens: 100, completion_tokens: 20 } } : null;
    } finally { this.inflight--; }
  }
  available() { return this.up; }
  health() { return { status: 'ok' as const, model: this.model }; }
}

export const toolMsgs = (req: ToolChatRequest) => req.messages.filter((m) => m.role === 'tool');
export function resultOf(req: ToolChatRequest, name: string): any {
  const m = toolMsgs(req).find((x) => (x.content ?? '').startsWith(`<tool_result name="${name}"`));
  if (!m) return null;
  return JSON.parse((m.content as string).split('\n')[1].replace(/…\[truncated\]$/, ''));
}
export function responderIds(req: ToolChatRequest): string[] {
  const r = resultOf(req, 'list_available_responders');
  return (r?.responders ?? []).map((x: any) => x.id);
}

export const goodAssessment = (responder: string | null, over: Record<string, unknown> = {}) => ({
  summary: 'Trapped family with rising water; flash flood warning and a rising gauge agree with the report.',
  urgency_delta: 5, confidence: 'high',
  evidence: [{ source: 'get_weather_alerts', finding: 'Flash Flood Warning active' }, { source: 'get_river_gauges', finding: 'Gauge rising' }],
  risks: ['Water still rising', 'Possible loss of contact'],
  recommendation: { responder_id: responder, eta_minutes: 12, equipment: ['boat', 'life jackets'], facility: { kind: 'hospital', name: 'Parkland Memorial Hospital', distance_km: 3.1 }, victim_message: 'Help is being sent. Move to the highest floor and stay on the line.', notes: 'Approach from the north.' },
  ...over,
});

/** plan + 6 parallel calls, then routing + two more, then submit */
export function standardScript(o: { delta?: number; assessment?: (ids: string[]) => unknown } = {}): Script {
  return (req) => {
    const n = req.messages.filter((m) => m.role === 'assistant').length + 1; // turn within this run
    if (n === 1) return msg('Plan: read the case, nearby cases, responders, weather, river and flood zone, then route and decide.', [
      call('get_case_context'), call('get_nearby_cases', { radius_km: 3 }), call('list_available_responders'), call('get_weather_alerts'), call('get_river_gauges'), call('get_flood_zone'),
    ]);
    if (n === 2) return msg(null, [call('reverse_geocode'), call('nearest_facilities', { kind: 'hospital' }), call('get_travel_times', { responder_ids: responderIds(req).slice(0, 2) })]);
    const ids = responderIds(req);
    return msg(null, [call('submit_assessment', o.assessment ? o.assessment(ids) : goodAssessment(ids[0] ?? null, { urgency_delta: o.delta ?? 5 }))]);
  };
}

export interface FakeNet { fetch: typeof fetch; urls: string[]; bodies: string[]; setWeather(w: 'empty' | 'flood' | 'fail'): void; overpass: Array<number | object>; hang: boolean }
export function fakeNet(): FakeNet {
  const net: FakeNet = {
    urls: [], bodies: [], overpass: [], hang: false,
    setWeather(w) { weather = w; },
    fetch: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      net.urls.push(u);
      if (init?.body) net.bodies.push(String(init.body));
      const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
      if (net.hang) await new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
      if (u.includes('api.weather.gov')) return weather === 'fail' ? new Response('down', { status: 503 }) : json(fx(weather === 'flood' ? 'nws_alerts_flood.json' : 'nws_alerts_empty.json'));
      if (u.includes('waterservices.usgs.gov')) return json(fx('usgs_iv.json'));
      if (u.includes('api.water.noaa.gov/nwps/v1/gauges?')) return json(fx('nwps_list.json'));
      if (u.includes('api.water.noaa.gov/nwps/v1/gauges/')) return json(fx('nwps_detail.json'));
      if (u.includes('hazards.fema.gov')) return json(fx('fema.json'));
      if (u.includes('router.project-osrm.org')) return json(fx('osrm_table.json'));
      if (u.includes('nominatim.openstreetmap.org')) return json(fx('nominatim.json'));
      if (u.includes('/api/interpreter') || u.includes('/api/')) {
        const next = net.overpass.length ? net.overpass.shift()! : 200;
        return typeof next === 'number' ? (next === 200 ? json(fx('overpass.json')) : new Response('busy', { status: next })) : json(next);
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch,
  };
  let weather: 'empty' | 'flood' | 'fail' = 'empty';
  return net;
}

let n = 0;
/** direct POST /sos from a device at an exact, unique-ish place */
export async function mkCase(env: TestEnv, dev: TestDevice, over: Record<string, unknown> = {}) {
  n++;
  const body = { id: uuidv7(), channel: 'app', category: 'trapped', lat: EXACT.lat + n * 0.2, lng: EXACT.lng - n * 0.2, text: `trapped on the second floor, water rising fast case${n}`, people_count: 3, trapped: true, water_rising: true, ...over };
  const res = await env.signed(dev, 'POST', '/v1/sos', body);
  if (res.status >= 300) throw new Error(`createSos ${res.status} ${JSON.stringify(res.body)}`);
  return { id: body.id as string, lat: body.lat as number, lng: body.lng as number };
}
export async function setResponderPos(env: TestEnv, username: string, lat: number, lng: number) {
  await env.ctx.pool.query('update responders set lat = $2, lng = $3, last_seen_at = now(), available = true where username = $1', [username, lat, lng]);
}
export const runRow = async (env: TestEnv, sosId: string) => (await env.ctx.pool.query('select * from agent_runs where sos_id = $1 order by created_at desc limit 1', [sosId])).rows[0];
export const runRows = async (env: TestEnv, sosId: string) => (await env.ctx.pool.query('select * from agent_runs where sos_id = $1 order by created_at', [sosId])).rows;
export const waitRun = async (env: TestEnv, sosId: string, status = 'complete', ms = 10000) => { await until(async () => (await runRow(env, sosId))?.status === status, ms); return runRow(env, sosId); };
export const AGENT_ENV = { AGENT_ENABLED: 'true', AGENT_EXTERNAL_TOOLS: 'true', AGENT_RERUN_MIN_S: '0' };
export type { ChatMessage };
