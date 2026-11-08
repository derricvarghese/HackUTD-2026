import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { runAgentLoop, SYSTEM_PROMPT } from '../../src/agent/loop';
import { execTool } from '../../src/agent/tools';
import { call, fakeNet, goodAssessment, mkCase, msg, ScriptedLlm, setResponderPos, sleep, standardScript, toolMsgs, EXACT, PRECISE, responderIds } from '../agentUtils';

let t: TestEnv | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

const EXT = { AGENT_EXTERNAL_TOOLS: 'true' };
async function setup(llm: ScriptedLlm, env: Record<string, string> = {}, net = fakeNet()) {
  t = await startTestApp({ llm, fetch: net.fetch, env: { AGENT_ENABLED: 'false', ...env } });
  const dev = await t.registerDevice();
  const c = await mkCase(t, dev);
  await setResponderPos(t, 'alice', 32.8, -96.7); await setResponderPos(t, 'bob', 32.7, -96.9);
  const row = async () => (await t!.ctx.db.selectFrom('sos').selectAll().where('id', '=', c.id).executeTakeFirstOrThrow());
  return { dev, c, net, row };
}

describe('agent loop', () => {
  it('plans, calls tools in parallel, submits; every step is traced; prompts carry no exact coordinates', async () => {
    const llm = new ScriptedLlm(standardScript());
    const { c, row, net } = await setup(llm, EXT);
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'new_case' });
    expect(out.error).toBeNull();
    expect(out.assessment?.recommendation.responder_id).toBeTruthy();
    expect(llm.requests).toHaveLength(3); // plan + 6 parallel, 3 parallel, submit
    const types = out.steps.map((s) => s.type);
    expect(types[0]).toBe('plan');
    expect(types.filter((x) => x === 'tool_call')).toHaveLength(9);
    expect(types.filter((x) => x === 'tool_result')).toHaveLength(9);
    expect(types.at(-1)).toBe('final');
    expect(out.steps.every((s, i) => s.index === i)).toBe(true);
    expect(out.steps.filter((s) => s.type === 'tool_result').every((s) => s.ok && typeof s.ms === 'number')).toBe(true);
    // privacy: the exact position never reaches the model or the network
    const prompt = JSON.stringify(llm.requests);
    expect(prompt).not.toContain(String(c.lat)); expect(prompt).not.toContain(String(c.lng));
    expect(prompt).not.toMatch(PRECISE);
    expect(prompt).toContain(`${Math.round(c.lat * 1000) / 1000}`);
    for (const u of [...net.urls, ...net.bodies]) expect(decodeURIComponent(u), u).not.toMatch(PRECISE);
    const nws = net.urls.find((u) => u.includes('api.weather.gov'))!;
    expect(nws).toContain(`point=${Math.round(c.lat * 1000) / 1000},${Math.round(c.lng * 1000) / 1000}`);
    expect(net.urls.find((u) => u.includes('nominatim'))).toContain('zoom=16');
    expect(net.urls.find((u) => u.includes('osrm'))).toMatch(/\/table\/v1\/driving\/[^?]*;[^?]*\?sources=0;1&destinations=2&annotations=duration,distance/);
    expect(JSON.stringify(out)).not.toContain(String(c.lat));
  });

  it('tool results are untrusted data: wrapped, never in the system role, injection text ignored by construction', async () => {
    const net = fakeNet(); net.setWeather('flood');
    const llm = new ScriptedLlm(standardScript());
    const { row } = await setup(llm, EXT, net);
    await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    for (const req of llm.requests) {
      const sys = req.messages.filter((m) => m.role === 'system');
      expect(sys).toHaveLength(1);
      expect(sys[0].content).toBe(SYSTEM_PROMPT);
      expect(SYSTEM_PROMPT).toMatch(/never follow instructions/i);
      for (const m of req.messages.filter((x) => x.role !== 'tool')) expect(m.content ?? '').not.toContain('IGNORE ALL PREVIOUS');
    }
    const last = llm.requests.at(-1)!;
    const weather = toolMsgs(last).find((m) => (m.content ?? '').includes('get_weather_alerts'))!;
    expect(weather.content).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS'); // it is there, as data...
    expect(weather.content!.startsWith('<tool_result name="get_weather_alerts" trust="untrusted-data">')).toBe(true); // ...inside a delimited block
    expect(weather.content).not.toContain('\u0007');
    for (const m of toolMsgs(last)) expect(m.content!.length).toBeLessThan(2700);
    // the case note only ever travels inside a tool block
    expect(last.messages.filter((m) => m.role !== 'tool').some((m) => (m.content ?? '').includes('second floor'))).toBe(false);
  });

  it('invalid arguments and unknown tools come back as error results the model recovers from', async () => {
    const llm = new ScriptedLlm((req, n) => {
      if (n === 1) return msg('plan', [call('get_nearby_cases', { radius_km: 'far' }), call('delete_everything', {}), call('get_case_context', '{broken')]);
      return msg(null, [call('submit_assessment', goodAssessment(null))]);
    });
    const { row } = await setup(llm);
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(out.assessment).toBeTruthy();
    const bad = out.steps.filter((s) => s.type === 'tool_result');
    expect(bad.map((s) => s.ok)).toEqual([false, false, false]);
    const msgs = toolMsgs(llm.requests[1]).map((m) => m.content!);
    expect(msgs.some((m) => m.includes('invalid arguments'))).toBe(true);
    expect(msgs.some((m) => m.includes('unknown tool') && m.includes('available_tools'))).toBe(true);
    expect(msgs.some((m) => m.includes('not valid JSON'))).toBe(true);
  });

  it('caps parallel tool calls per turn at MAX_PARALLEL', async () => {
    const llm = new ScriptedLlm((_r, n) => (n === 1 ? msg('p', Array.from({ length: 14 }, () => call('get_dead_zones'))) : msg(null, [call('submit_assessment', goodAssessment(null))])));
    const { row } = await setup(llm);
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(out.steps.filter((s) => s.type === 'tool_result' && s.ok)).toHaveLength(12);
    expect(out.steps.filter((s) => s.summary.includes('too many parallel'))).toHaveLength(2);
    expect(toolMsgs(llm.requests[1])).toHaveLength(14); // every call id is answered
  });

  it('hard step cap: the last turn can only submit, and a model that never does fails the run', async () => {
    const llm = new ScriptedLlm(() => msg('thinking', [call('get_case_context')]));
    const { row } = await setup(llm, { AGENT_MAX_STEPS: '3' });
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(out.assessment).toBeNull();
    expect(out.error).toMatch(/step limit/);
    expect(llm.requests).toHaveLength(3);
    const lastReq = llm.requests[2];
    expect(lastReq.toolChoice).toEqual({ type: 'function', function: { name: 'submit_assessment' } });
    expect((lastReq.tools as any[]).map((x) => x.function.name)).toEqual(['submit_assessment']);
    expect(llm.requests[0].toolChoice).toBe('auto');
    expect(llm.requests[0].thinking).toBe(false);
    expect(out.steps.at(-1)).toMatchObject({ type: 'final', ok: false });
  });

  it('thinking is configurable', async () => {
    const llm = new ScriptedLlm(() => msg(null, [call('submit_assessment', goodAssessment(null))]));
    const { row } = await setup(llm, { AGENT_THINKING: 'true' });
    await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(llm.requests[0].thinking).toBe(true);
  });

  it('total timeout ends the run with the partial trace', async () => {
    const llm = new ScriptedLlm(async (_r, n) => { if (n === 1) { await sleep(700); return msg('plan', [call('get_case_context')]); } return msg(null, [call('submit_assessment', goodAssessment(null))]); });
    const { row } = await setup(llm, { AGENT_TIMEOUT_MS: '1000' });
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(out.assessment).toBeNull();
    expect(out.error).toBe('timeout');
    expect(out.steps.some((s) => s.tool === 'get_case_context' && s.type === 'tool_result')).toBe(true);
    expect(llm.requests).toHaveLength(1);
  });

  it('per-tool timeout: a hanging upstream becomes an error result quickly', async () => {
    const net = fakeNet(); net.hang = true;
    const llm = new ScriptedLlm((_r, n) => (n === 1 ? msg('p', [call('get_weather_alerts'), call('get_case_context')]) : msg(null, [call('submit_assessment', goodAssessment(null))])));
    const { row } = await setup(llm, { ...EXT, AGENT_TOOL_TIMEOUT_EXTERNAL_MS: '300' }, net);
    const started = Date.now();
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(Date.now() - started).toBeLessThan(2500);
    const w = out.steps.find((s) => s.tool === 'get_weather_alerts' && s.type === 'tool_result')!;
    expect(w).toMatchObject({ ok: false });
    expect(w.summary).toBe('timeout');
    expect(out.steps.find((s) => s.tool === 'get_case_context' && s.type === 'tool_result')!.ok).toBe(true);
    expect(out.assessment).toBeTruthy(); // the model carried on without that evidence
  });

  it('invalid submit_assessment: asked once to resubmit; invalid twice fails; hallucinated responder is refused', async () => {
    const ok = new ScriptedLlm((_r, n) => msg(null, [call('submit_assessment', n === 1 ? goodAssessment(null, { summary: 'x'.repeat(400) }) : goodAssessment(null))]));
    const s1 = await setup(ok);
    const out = await runAgentLoop(t!.ctx, await s1.row(), { trigger: 'manual' });
    expect(out.assessment).toBeTruthy();
    expect(ok.requests).toHaveLength(2);
    expect(toolMsgs(ok.requests[1])[0].content).toContain('summary');
    await t!.close();

    const twice = new ScriptedLlm(() => msg(null, [call('submit_assessment', { summary: '' })]));
    const s2 = await setup(twice);
    const out2 = await runAgentLoop(t!.ctx, await s2.row(), { trigger: 'manual' });
    expect(out2.assessment).toBeNull();
    expect(out2.error).toMatch(/invalid assessment/);
    expect(twice.requests).toHaveLength(2);
    await t!.close();

    const halluc = new ScriptedLlm((_r, n) => msg(null, [call('submit_assessment', goodAssessment(n === 1 ? '33333333-3333-4333-8333-333333333333' : null))]));
    const s3 = await setup(halluc);
    const out3 = await runAgentLoop(t!.ctx, await s3.row(), { trigger: 'manual' });
    expect(toolMsgs(halluc.requests[1])[0].content).toContain('list_available_responders');
    expect(out3.assessment?.recommendation.responder_id).toBeNull();
  });

  it('a model that answers in prose is nudged once, then the run fails with the trace', async () => {
    const llm = new ScriptedLlm(() => msg('I think they need help.'));
    const { row } = await setup(llm);
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(out.assessment).toBeNull();
    expect(out.error).toMatch(/did not submit/);
    expect(llm.requests).toHaveLength(2);
    expect(out.steps.filter((s) => s.type === 'plan')).toHaveLength(2);
  });

  it('an unavailable LLM fails fast', async () => {
    const llm = new ScriptedLlm(() => null);
    const { row } = await setup(llm);
    const out = await runAgentLoop(t!.ctx, await row(), { trigger: 'manual' });
    expect(out.error).toMatch(/llm/);
  });
});

describe('tools with recorded fixtures', () => {
  const exec = async (name: string, args: unknown = {}, o: { env?: Record<string, string>; net?: ReturnType<typeof fakeNet> } = {}) => {
    const s = await setup(new ScriptedLlm(() => null), { ...EXT, ...(o.env ?? {}) }, o.net);
    return { ...s, run: (nm = name, a: unknown = args) => execTool(t!.ctx, undefined as never, nm, JSON.stringify(a), Date.now() + 5000) };
  };
  const go = async (name: string, args: unknown = {}, o: Parameters<typeof exec>[2] = {}) => {
    const s = await exec(name, args, o);
    const r = await execTool(t!.ctx, await s.row(), name, JSON.stringify(args), Date.now() + 5000);
    return { r, s };
  };

  it('get_case_context: sanitised profile context only; no coordinates, name, phone, address or contacts', async () => {
    const llm = new ScriptedLlm(() => null);
    t = await startTestApp({ llm, env: { AGENT_ENABLED: 'false' } });
    const dev = await t.registerDevice();
    const put = await t.signed(dev, 'PUT', `/v1/devices/${dev.id}/profile`, {
      full_name: 'Maria Elena Gonzalez', preferred_name: 'Elena', birth_year: new Date().getUTCFullYear() - 80, phone: '+19725550142', home_address: '412 Cedar Ln, Richardson, TX',
      medical: { conditions: ['type 2 diabetes'], medications: ['insulin glargine'] }, mobility: { needs: ['cannot_walk'] }, emergency_contact: { name: 'Daniel Gonzalez', phone: '+19725550177', relationship: 'son' },
      notes: 'key under the green pot', consent: { accepted: true, version: '2026-11-v1', accepted_at: new Date().toISOString() },
    });
    expect([200, 201]).toContain(put.status);
    const c = await mkCase(t, dev);
    const row = await t.ctx.db.selectFrom('sos').selectAll().where('id', '=', c.id).executeTakeFirstOrThrow();
    const r = await execTool(t.ctx, row, 'get_case_context', '{}', Date.now() + 2000);
    expect(r.ok).toBe(true);
    const j = JSON.stringify(r.result);
    for (const pii of ['Maria', 'Gonzalez', 'Elena', '972555', 'Cedar', 'Richardson', 'Daniel', 'green pot']) expect(j, pii).not.toContain(pii);
    expect(j).not.toContain(String(c.lat));
    expect((r.result as any).profile_context).toMatchObject({ medications: ['insulin glargine'], mobility_needs: expect.any(Array) });
    expect((r.result as any).case.approx_position).toEqual({ lat: Math.round(c.lat * 1000) / 1000, lng: Math.round(c.lng * 1000) / 1000 });
  });

  it('internal tools: nearby cases (no coordinates or names), responders (coarse), dead zones, event context', async () => {
    const llm = new ScriptedLlm(() => null);
    const s = await setup(llm);
    const dev2 = await t!.registerDevice();
    await mkCase(t!, dev2, { lat: s.c.lat + 0.01, lng: s.c.lng + 0.01 });
    const near = await execTool(t!.ctx, await s.row(), 'get_nearby_cases', '{"radius_km":3}', Date.now() + 2000);
    expect((near.result as any).open_cases).toBe(1);
    expect((near.result as any).severity_mix.critical).toBe(1);
    expect(JSON.stringify(near.result)).not.toMatch(PRECISE);
    const rs = await execTool(t!.ctx, await s.row(), 'list_available_responders', '{}', Date.now() + 2000);
    const list = (rs.result as any).responders;
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const r of list) { expect(Object.keys(r)).toEqual(expect.arrayContaining(['id', 'name', 'role', 'skills', 'available', 'active_assignments', 'position', 'last_seen_minutes_ago'])); if (r.position) expect(JSON.stringify(r.position)).not.toMatch(PRECISE); }
    expect(JSON.stringify(rs.result)).not.toContain('password');
    await t!.ctx.pool.query("insert into deadzones (center_lat, center_lng, radius_m, status, reason) values ($1, $2, 800, 'open', 'quiet')", [s.c.lat + 0.001, s.c.lng]);
    const dz = await execTool(t!.ctx, await s.row(), 'get_dead_zones', '{}', Date.now() + 2000);
    expect((dz.result as any).inside_dead_zone).toBe(true);
    const ev = await execTool(t!.ctx, await s.row(), 'get_event_context', '{}', Date.now() + 2000);
    expect(ev.ok).toBe(true);
  });

  it('weather: NWS shape, caching, 5xx becomes an error result, demo flash flood is labelled synthetic', async () => {
    const net = fakeNet(); net.setWeather('flood');
    const { r, s } = await go('get_weather_alerts', {}, { net });
    expect(r.ok).toBe(true);
    expect((r.result as any).alerts[0]).toMatchObject({ event: 'Flood Advisory', severity: 'Minor', urgency: 'Expected' });
    expect((r.result as any).alerts[0].headline).not.toContain('\u0007');
    const before = net.urls.length;
    const again = await execTool(t!.ctx, await s.row(), 'get_weather_alerts', '{}', Date.now() + 2000);
    expect(again.cached).toBe(true);
    expect(net.urls.length).toBe(before);
    await t!.close();
    const bad = fakeNet(); bad.setWeather('fail');
    const f = await go('get_weather_alerts', {}, { net: bad });
    expect(f.r).toMatchObject({ ok: false });
    expect(bad.urls.length).toBe(2); // one retry
    await t!.close();
    const demo = await go('get_weather_alerts', {}, { net: fakeNet(), env: { DEMO_MODE: 'true', AGENT_DEMO_WEATHER: 'flash_flood' } });
    expect((demo.r.result as any).synthetic).toBe(true);
    expect(demo.r.synthetic).toBe(true);
    expect((demo.r.result as any).alerts[0]).toMatchObject({ event: 'Flash Flood Warning', synthetic: true });
  });

  it('rivers: USGS + NWPS joined, trend and flood category; demo gauge is synthetic', async () => {
    const { r } = await go('get_river_gauges', { radius_km: 10 });
    const res = r.result as any;
    expect(res.usgs[0]).toMatchObject({ site_no: '08049500', gage_height_ft: 3.6, trend: 'rising' });
    expect(res.nwps).toHaveLength(2); expect(res.nwps[0]).toMatchObject({ flood_category: 'minor', thresholds_ft: { minor: 30 } });
    await t!.close();
    const demo = await go('get_river_gauges', {}, { env: { DEMO_MODE: 'true', AGENT_DEMO_WEATHER: 'flash_flood' } });
    expect((demo.r.result as any).usgs[0]).toMatchObject({ synthetic: true, trend: 'rising', flood_category: 'moderate' });
  });

  it('flood zone, reverse geocode (no house number), travel times (0 = unknown, ; separated)', async () => {
    const z = await go('get_flood_zone');
    expect(z.r.result).toMatchObject({ mapped: true, zone: 'AE', high_risk: true });
    const g = await execTool(t!.ctx, await z.s.row(), 'reverse_geocode', '{}', Date.now() + 5000);
    expect(g.result).toMatchObject({ found: true, road: 'Marilla Street', city: 'Dallas' });
    expect(JSON.stringify(g.result)).not.toMatch(/1500|house/);
    expect(g.summary).not.toContain('Marilla');
    const tt = await execTool(t!.ctx, await z.s.row(), 'get_travel_times', '{}', Date.now() + 5000);
    const travel = (tt.result as any).travel;
    expect(tt.result).toMatchObject({ method: 'osrm' });
    expect(travel.some((x: any) => x.minutes === null && /unknown/.test(x.note))).toBe(true);
    expect(travel.some((x: any) => typeof x.minutes === 'number' && x.minutes > 0)).toBe(true);
    const url = z.s.net.urls.find((u) => u.includes('osrm'))!;
    expect(url).not.toContain(',,');
    expect(decodeURIComponent(url)).not.toMatch(PRECISE);
  });

  it('travel times fall back to a straight-line estimate when OSRM is down', async () => {
    const net = fakeNet();
    const orig = net.fetch;
    net.fetch = (async (u: string, i: RequestInit) => (String(u).includes('osrm') ? new Response('x', { status: 503 }) : orig(u, i))) as never;
    const { r } = await go('get_travel_times', {}, { net });
    expect(r.result).toMatchObject({ method: 'straight_line_estimate' });
    expect((r.result as any).travel[0].estimate).toBe(true);
  });

  it('Nominatim: results cached per coarse point, requests spaced by the limiter', async () => {
    const net = fakeNet();
    const s = await setup(new ScriptedLlm(() => null), EXT, net);
    const dev2 = await t!.registerDevice();
    const c2 = await mkCase(t!, dev2);
    const r1 = await s.row();
    const r2 = await t!.ctx.db.selectFrom('sos').selectAll().where('id', '=', c2.id).executeTakeFirstOrThrow();
    const stamps: number[] = [];
    const orig = net.fetch;
    net.fetch = (async (u: string, i: RequestInit) => { if (String(u).includes('nominatim')) stamps.push(Date.now()); return orig(u, i); }) as never;
    t!.ctx.fetch = net.fetch;
    await Promise.all([execTool(t!.ctx, r1, 'reverse_geocode', '{}', Date.now() + 5000), execTool(t!.ctx, r2, 'reverse_geocode', '{}', Date.now() + 5000)]);
    expect(stamps).toHaveLength(2);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(100);
    const again = await execTool(t!.ctx, r1, 'reverse_geocode', '{}', Date.now() + 5000);
    expect(again.cached).toBe(true);
    expect(stamps).toHaveLength(2);
  });

  it('external tools are off when AGENT_EXTERNAL_TOOLS=false', async () => {
    const net = fakeNet();
    const { r } = await go('get_flood_zone', {}, { env: { AGENT_EXTERNAL_TOOLS: 'false' }, net });
    expect(r).toMatchObject({ ok: false });
    expect(net.urls).toHaveLength(0);
  });
});
void EXACT; void responderIds;
