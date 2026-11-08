import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestEnv } from '../helpers';
import { rulesTriage } from '../../src/domain/triage/rules';
import { execTool } from '../../src/agent/tools';
import { runtimeOf, TtlCache } from '../../src/agent/net';
import {
  AGENT_ENV, auth, call, EXACT, fakeNet, goodAssessment, mkCase, msg, PII, PRECISE, runRow, runRows, ScriptedLlm, setResponderPos, sleep, standardScript, until, waitRun,
} from '../agentUtils';

let t: TestEnv | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function boot(llm: ScriptedLlm, env: Record<string, string> = {}, net = fakeNet()) {
  t = await startTestApp({ llm, fetch: net.fetch, env: { ...AGENT_ENV, ...env } });
  const [alice, bob, carol, admin] = await Promise.all(['alice', 'bob', 'carol', 'admin'].map((u) => t!.login(u)));
  await setResponderPos(t, 'alice', 32.8, -96.7); await setResponderPos(t, 'bob', 32.7, -96.9);
  const dev = await t.registerDevice();
  return { alice, bob, carol, admin, dev, net };
}
const get = (path: string, u: { token: string }) => t!.request.get(`/v1${path}`).set(auth(u));
const post = (path: string, u: { token: string }, body?: unknown) => t!.request.post(`/v1${path}`).set(auth(u)).send(body ?? {});
const submitOnly = (n: { delta?: number } = {}) => new ScriptedLlm(standardScript(n));

describe('runner: a case gets an agent run after its AI triage', () => {
  it('full flow: provisional -> AI extraction -> agent run -> proposal; WS carries steps without PII; Sos shows agent status', async () => {
    const llm = submitOnly({ delta: 5 });
    const { alice, dev } = await boot(llm);
    const put = await t!.signed(dev, 'PUT', `/v1/devices/${dev.id}/profile`, {
      full_name: 'Maria Elena Gonzalez', preferred_name: 'Elena', birth_year: new Date().getUTCFullYear() - 80, phone: '+19725550142', home_address: '412 Cedar Ln, Richardson, TX',
      medical: { conditions: ['type 2 diabetes'], medications: ['insulin glargine'] }, emergency_contact: { name: 'Daniel Gonzalez', phone: '+19725550177', relationship: 'son' },
      notes: 'key under the green pot', appearance: { clothing: 'blue cardigan' }, consent: { accepted: true, version: '2026-11-v1', accepted_at: new Date().toISOString() },
    });
    expect([200, 201]).toContain(put.status);
    const ws = await t!.ws(alice.token);
    const c = await mkCase(t!, dev);
    await ws.waitFor('agent.updated', (d) => d.sos_id === c.id && d.status === 'complete', 12000);
    const run = await runRow(t!, c.id);
    expect(run.status).toBe('complete');
    expect(run.trigger).toBe('new_case');
    expect(run.model).toBe('fake-agent-llm');
    const body = (await get(`/sos/${c.id}/agent`, alice)).body;
    expect(body.status).toBe('complete');
    expect(body.assessment.recommendation.responder_id).toBeTruthy();
    expect(body.proposal).toMatchObject({ status: 'proposed', kind: 'dispatch', run_id: body.id });
    expect(body.steps.length).toBeGreaterThanOrEqual(15);
    expect(body.tokens.turns).toBe(3);
    // the Sos view carries the queue-card fields
    const sos = (await get(`/sos/${c.id}`, alice)).body;
    expect(sos.agent_status).toBe('complete');
    expect(sos.agent_summary).toBe(body.assessment.summary);
    // score: extraction +0, agent +5 within the bound; the agent reason is tagged
    expect(sos.reasons.some((r: any) => r.tag === 'agent' && r.source === 'llm')).toBe(true);
    expect(body.assessment.score_effect.requested_delta).toBe(5);
    // privacy: no PII or exact coordinate in the prompts, the stored run, the proposal, or any websocket frame
    const everything = JSON.stringify({ prompts: llm.requests, run: (await t!.ctx.pool.query('select * from agent_runs')).rows, props: (await t!.ctx.pool.query('select * from agent_proposals')).rows, api: body, frames: ws.frames.filter((f) => f.event.startsWith('agent.')) });
    for (const pii of PII) expect(everything, pii).not.toContain(pii);
    expect(everything).not.toContain(String(c.lat)); expect(everything).not.toContain(String(c.lng));
    const wsOnly = JSON.stringify(ws.frames.filter((f) => f.event.startsWith('agent.')));
    expect(wsOnly).not.toMatch(PRECISE);
    const stepFrames = ws.frames.filter((f) => f.event === 'agent.step' && f.data.sos_id === c.id);
    expect(stepFrames.length).toBe(body.steps.length);
    expect(Object.keys(stepFrames[0].data).sort()).toEqual(['index', 'ok', 'ms', 'run_id', 'sos_id', 'summary', 'synthetic', 'tool', 'type'].sort());
    expect(stepFrames.map((f) => f.data.index)).toEqual(body.steps.map((s: any) => s.index));
    // logs are not asserted here; the runner only logs step names and timings
    ws.close();
  });

  it('volunteers receive no agent frames', async () => {
    const { carol, dev } = await boot(submitOnly());
    const ws = await t!.ws(carol.token);
    const c = await mkCase(t!, dev);
    await waitRun(t!, c.id);
    await sleep(100);
    expect(ws.frames.some((f) => f.event.startsWith('agent.'))).toBe(false);
    expect(ws.frames.some((f) => f.event === 'sos.updated')).toBe(true);
    ws.close();
  });

  it('score bound: a hallucinating agent cannot bury a critical case; combined adjustment stays within +/-15', async () => {
    const llm = new ScriptedLlm(standardScript({ delta: -15 }));
    llm.extractDelta = -15;
    const { alice, dev } = await boot(llm);
    const c = await mkCase(t!, dev); // trapped + rising water: floor 90
    await waitRun(t!, c.id);
    const rules = rulesTriage({ category: 'trapped', trapped: true, water_rising: true, text: `trapped on the second floor, water rising fast case1`, people_count: 3 });
    const sos = (await get(`/sos/${c.id}`, alice)).body;
    expect(sos.score).toBeGreaterThanOrEqual(rules.floor);
    expect(sos.score).toBeGreaterThanOrEqual(90);
    await t!.close();

    const llm2 = new ScriptedLlm(standardScript({ delta: 15 }));
    llm2.extractDelta = 10;
    const b2 = await boot(llm2);
    const c2 = await mkCase(t!, b2.dev, { category: 'need_water_meds', trapped: false, water_rising: false, text: 'needs insulin', people_count: 1 });
    await waitRun(t!, c2.id);
    const r2 = rulesTriage({ category: 'need_water_meds', text: 'needs insulin', people_count: 1 });
    const s2 = (await get(`/sos/${c2.id}`, b2.alice)).body;
    expect(s2.score).toBe(r2.score + 15); // 10 + 15 requested, capped at +15 combined
    expect(s2.reasons.filter((r: any) => r.tag === 'agent')).toHaveLength(1);
    const detail = (await get(`/sos/${c2.id}/agent`, b2.alice)).body.assessment.score_effect;
    expect(detail).toMatchObject({ requested_delta: 15 });
    expect(detail.applied_delta).toBe(5);
  });

  it('a re-run does not stack on the previous agent adjustment', async () => {
    const { alice, dev } = await boot(submitOnly({ delta: 10 }));
    const c = await mkCase(t!, dev, { category: 'need_water_meds', trapped: false, water_rising: false, text: 'needs insulin', people_count: 1 });
    await waitRun(t!, c.id);
    const first = (await get(`/sos/${c.id}`, alice)).body.score;
    await post(`/sos/${c.id}/agent/run`, alice);
    await until(async () => (await runRows(t!, c.id)).filter((r) => r.status === 'complete').length === 2);
    expect((await get(`/sos/${c.id}`, alice)).body.score).toBe(first);
  });

  it('skip rules: safe tier is skipped unless unresponsive; one active run per case; coalescing; manual bypasses the throttle', async () => {
    const llm = submitOnly();
    const { alice, dev } = await boot(llm, { AGENT_RERUN_MIN_S: '120' });
    const safe = await mkCase(t!, dev, { category: 'safe', trapped: false, water_rising: false, text: 'all good', people_count: 1 });
    await t!.ctx.idle(); await sleep(150);
    expect(await runRows(t!, safe.id)).toHaveLength(0);
    await t!.ctx.pool.query('update sos set silent = true, welfare_missed = 1 where id = $1', [safe.id]); // unresponsive
    await t!.ctx.agent.trigger(safe.id, 'contact_change');
    await waitRun(t!, safe.id);

    const c = await mkCase(t!, dev);
    await waitRun(t!, c.id);
    // throttle: an automatic re-trigger within 2 minutes is deferred, not run
    await t!.ctx.agent.trigger(c.id, 'contact_change');
    await t!.ctx.agent.trigger(c.id, 'checkin');
    expect(await runRows(t!, c.id)).toHaveLength(1);
    expect(t!.ctx.agent.deferred()).toBeGreaterThanOrEqual(1);
    // manual re-run is exempt
    const m = await post(`/sos/${c.id}/agent/run`, alice);
    expect(m.status).toBe(202);
    expect(m.body.trigger).toBe('manual');
    await until(async () => (await runRows(t!, c.id)).length === 2 && (await runRow(t!, c.id)).status === 'complete');
    // coalescing: while one is queued/running, more triggers give the same run
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    llm.script = async (req, n) => { if (req.messages.length === 2) await gate; return standardScript()(req, n); };
    llm.requests.length = 0;
    const a = await t!.ctx.agent.trigger(c.id, 'manual');
    const b = await t!.ctx.agent.trigger(c.id, 'manual');
    expect(b!.id).toBe(a!.id);
    release();
    await until(async () => (await runRow(t!, c.id)).status === 'complete' && (await runRows(t!, c.id)).length === 3);
    expect((await t!.ctx.pool.query("select count(*)::int n from agent_runs where status in ('queued','running')")).rows[0].n).toBe(0);
  });

  it('concurrency is bounded and critical cases go first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const llm = new ScriptedLlm(async (req, n) => { if (req.messages.length === 2) await gate; return standardScript()(req, n); });
    const { dev } = await boot(llm, { AGENT_CONCURRENCY: '1' });
    const low = await mkCase(t!, dev, { category: 'other', trapped: false, water_rising: false, text: 'minor issue', people_count: 1 });
    await until(async () => llm.inflight === 1);
    const mid = await mkCase(t!, await t!.registerDevice(), { category: 'need_water_meds', trapped: false, water_rising: false, text: 'needs insulin' });
    const crit = await mkCase(t!, await t!.registerDevice());
    await until(async () => (await t!.ctx.pool.query("select count(*)::int n from agent_runs")).rows[0].n === 3);
    expect(llm.maxInflight).toBe(1);
    const stats = await t!.ctx.agent.stats();
    expect(stats).toEqual({ queue_depth: 2, running: 1 });
    release();
    await until(async () => (await t!.ctx.pool.query("select count(*)::int n from agent_runs where status = 'complete'")).rows[0].n === 3, 20000);
    const rows = (await t!.ctx.pool.query('select sos_id from agent_runs order by started_at')).rows.map((r) => r.sos_id);
    expect(rows).toEqual([low.id, crit.id, mid.id]);
    expect(llm.maxInflight).toBe(1);
    void order;
  });

  it('restart recovery: stuck running and orphaned queued runs are picked up by the sweep, three tries at most', async () => {
    const { dev } = await boot(submitOnly());
    const c = await mkCase(t!, dev);
    await waitRun(t!, c.id);
    const mk = async (status: string, attempts: number, claimedAgoS: number | null) => (await t!.ctx.pool.query(
      "insert into agent_runs (sos_id, status, trigger, attempts, claimed_at, started_at) values ($1, $2, 'sweep', $3, case when $4::int is null then null else now() - make_interval(secs => $4::int) end, now()) returning id", [c.id, status, attempts, claimedAgoS])).rows[0].id;
    await t!.ctx.pool.query("update agent_runs set status = 'complete'"); // clear the unique active-run slot
    const stuck = await mk('running', 1, 3600);
    await t!.ctx.agent.sweep();
    await until(async () => (await t!.ctx.pool.query('select status from agent_runs where id = $1', [stuck])).rows[0].status === 'complete');
    await t!.ctx.pool.query("update agent_runs set status = 'complete'");
    const tooOften = await mk('running', 3, 3600);
    await t!.ctx.agent.sweep();
    expect((await t!.ctx.pool.query('select status, error from agent_runs where id = $1', [tooOften])).rows[0]).toMatchObject({ status: 'failed', error: 'interrupted by a restart' });
    await t!.ctx.pool.query("update agent_runs set status = 'complete'");
    const orphan = await mk('queued', 0, null);
    await t!.ctx.agent.sweep();
    await until(async () => (await t!.ctx.pool.query('select status from agent_runs where id = $1', [orphan])).rows[0].status === 'complete');
  });

  it('re-run triggers: contact change, urgent check-in, nearby critical count, new weather alert', async () => {
    const net = fakeNet();
    const { dev } = await boot(submitOnly(), {}, net);
    const c = await mkCase(t!, dev, { lat: 33.1, lng: -96.1 });
    await waitRun(t!, c.id);
    const n = async () => (await runRows(t!, c.id)).length;
    await t!.ctx.agent.trigger(c.id, 'contact_change');
    await until(async () => (await n()) === 2 && (await runRow(t!, c.id)).status === 'complete');
    expect((await runRow(t!, c.id)).trigger).toBe('contact_change');
    // a new critical case nearby changes the count: the sweep re-runs
    await mkCase(t!, await t!.registerDevice(), { lat: 33.105, lng: -96.105 });
    await t!.ctx.agent.sweep();
    await until(async () => (await n()) === 3 && (await runRow(t!, c.id)).status === 'complete');
    expect((await runRow(t!, c.id)).trigger).toBe('nearby_critical');
    // a new NWS alert appears
    net.setWeather('flood');
    runtimeOf(t!.ctx).cache = new TtlCache(); // the 60 s weather cache would otherwise hide the change
    await t!.ctx.agent.sweep();
    await until(async () => (await n()) === 4 && (await runRow(t!, c.id)).status === 'complete');
    expect((await runRow(t!, c.id)).trigger).toBe('weather_alert');
  });

  it('an urgent welfare answer triggers a re-run', async () => {
    const { dev, alice } = await boot(submitOnly());
    const c = await mkCase(t!, dev);
    await waitRun(t!, c.id);
    const ck = await post(`/sos/${c.id}/checkins`, alice, {});
    expect(ck.status).toBe(201);
    const r = await t!.signed(dev, 'PATCH', `/v1/checkins/${ck.body.id}`, { response: 'need_urgent_help' });
    expect(r.status).toBe(200);
    await until(async () => (await runRows(t!, c.id)).length === 2);
    expect((await runRow(t!, c.id)).trigger).toBe('checkin');
  });

  it('a failed run keeps the partial trace and the rules + extraction score stands', async () => {
    const llm = new ScriptedLlm((_r, n) => (n === 1 ? msg('plan', [call('get_case_context')]) : msg('no idea')));
    const { alice, dev } = await boot(llm);
    const c = await mkCase(t!, dev);
    await waitRun(t!, c.id, 'failed');
    const body = (await get(`/sos/${c.id}/agent`, alice)).body;
    expect(body.status).toBe('failed');
    expect(body.error).toMatch(/did not submit/);
    expect(body.assessment).toBeNull();
    expect(body.proposal).toBeNull();
    expect(body.steps.some((s: any) => s.tool === 'get_case_context' && s.ok)).toBe(true);
    expect(body.steps.at(-1)).toMatchObject({ type: 'final', ok: false });
    const sos = (await get(`/sos/${c.id}`, alice)).body;
    expect(sos.agent_status).toBe('failed');
    expect(sos.agent_summary).toBeNull();
    expect(sos.triage_status).toBe('complete');
    expect(sos.reasons.some((r: any) => r.tag === 'agent')).toBe(false);
  });

  it('disabled agent: no runs, health says so, manual run is refused', async () => {
    const { alice, dev } = await boot(submitOnly(), { AGENT_ENABLED: 'false' });
    const c = await mkCase(t!, dev);
    await t!.ctx.idle(); await sleep(100);
    expect(await runRows(t!, c.id)).toHaveLength(0);
    expect((await t!.request.get('/v1/health')).body.agent).toEqual({ status: 'disabled', queue_depth: 0, running: 0 });
    expect((await post(`/sos/${c.id}/agent/run`, alice)).status).toBe(409);
    expect((await get(`/sos/${c.id}`, alice)).body.agent_status).toBe('none');
  });

  it('health exposes the agent block', async () => {
    const llm = submitOnly();
    await boot(llm);
    expect((await t!.request.get('/v1/health')).body.agent).toEqual({ status: 'ok', queue_depth: 0, running: 0 });
    llm.up = false;
    expect((await t!.request.get('/v1/health')).body.agent.status).toBe('degraded');
  });
});

describe('human-in-the-loop API', () => {
  async function withProposal(env: Record<string, string> = {}) {
    const b = await boot(submitOnly(), env);
    const c = await mkCase(t!, b.dev);
    await waitRun(t!, c.id);
    const run = (await get(`/sos/${c.id}/agent`, b.alice)).body;
    const aliceId = b.alice.id ?? (await t!.ctx.pool.query("select id from responders where username='alice'")).rows[0].id;
    const named = run.proposal.responder_id as string;
    return { ...b, c, run, proposal: run.proposal, named, aliceId };
  }

  it('auth matrix: unauthenticated 401, volunteer 403 everywhere, admin and responder allowed, 404s', async () => {
    const { carol, alice, admin, c, proposal } = await withProposal();
    const paths: [string, string][] = [['get', `/sos/${c.id}/agent`], ['get', `/sos/${c.id}/agent/runs`], ['post', `/sos/${c.id}/agent/run`], ['post', `/sos/${c.id}/agent/proposals/${proposal.id}/approve`], ['post', `/sos/${c.id}/agent/proposals/${proposal.id}/reject`]];
    for (const [m, p] of paths) {
      expect((await (t!.request as any)[m](`/v1${p}`)).status, `${m} ${p} anon`).toBe(401);
      expect((await (t!.request as any)[m](`/v1${p}`).set(auth(carol)).send({})).status, `${m} ${p} volunteer`).toBe(403);
    }
    expect((await get(`/sos/${c.id}/agent`, alice)).status).toBe(200);
    expect((await get(`/sos/${c.id}/agent`, admin)).status).toBe(200);
    const runs = await get(`/sos/${c.id}/agent/runs`, alice);
    expect(runs.status).toBe(200);
    expect(runs.body.data[0]).toMatchObject({ status: 'complete', step_count: expect.any(Number), summary: expect.any(String), proposal_status: 'proposed' });
    expect(runs.body.data[0].steps).toBeUndefined();
    const missing = '0192a7d4-1c2e-7000-8a00-0000000000ff';
    expect((await get(`/sos/${missing}/agent`, alice)).status).toBe(404);
    const noRun = await mkCase(t!, await t!.registerDevice(), { category: 'safe', trapped: false, water_rising: false, text: 'ok' });
    expect((await get(`/sos/${noRun.id}/agent`, alice)).status).toBe(404);
    expect((await post(`/sos/${c.id}/agent/proposals/${missing}/approve`, admin)).status).toBe(404);
  });

  it('approve: a responder who is not named gets 403; the named one claims the case; a second approve is 409', async () => {
    const { alice, bob, admin, c, proposal, named } = await withProposal();
    const other = named === (await t!.ctx.pool.query("select id from responders where username='alice'")).rows[0].id ? bob : alice;
    const namedUser = other === bob ? alice : bob;
    expect((await post(`/sos/${c.id}/agent/proposals/${proposal.id}/approve`, other)).status).toBe(403);
    expect((await get(`/sos/${c.id}/agent`, admin)).body.proposal.status).toBe('proposed');
    const ok = await post(`/sos/${c.id}/agent/proposals/${proposal.id}/approve`, namedUser, { eta_minutes: 9, note: 'On my way' });
    expect(ok.status).toBe(200);
    expect(ok.body.proposal).toMatchObject({ status: 'approved', decided_by: named });
    expect(ok.body.assignment).toMatchObject({ responder_id: named, status: 'assigned', eta_minutes: 9, sos_id: c.id });
    const sos = (await get(`/sos/${c.id}`, admin)).body;
    expect(sos.status).toBe('assigned');
    expect(sos.assignment.responder_id).toBe(named);
    expect((await post(`/sos/${c.id}/agent/proposals/${proposal.id}/approve`, admin)).status).toBe(409);
    expect((await post(`/sos/${c.id}/agent/proposals/${proposal.id}/reject`, admin)).status).toBe(409);
    const cur = (await get(`/sos/${c.id}/agent`, admin)).body.proposal;
    expect(cur.status).toBe('approved');
  });

  it('the victim message is queued as a status_update only when asked, and only after the assignment', async () => {
    const q = async (sosId: string) => (await t!.ctx.pool.query("select body from mesh_outbox where sos_id = $1 and kind = 'status_update' order by created_at", [sosId])).rows.map((r) => r.body.message);
    const a = await withProposal();
    const msgText = a.proposal.victim_message as string;
    expect(msgText).toBeTruthy();
    const before = await q(a.c.id);
    expect((await post(`/sos/${a.c.id}/agent/proposals/${a.proposal.id}/approve`, a.admin, {})).status).toBe(200);
    const afterPlain = await q(a.c.id);
    expect(afterPlain.length).toBe(before.length + 1); // the usual assignment update only
    expect(afterPlain).not.toContain(msgText);
    await t!.close();

    const b = await withProposal();
    const res = await post(`/sos/${b.c.id}/agent/proposals/${b.proposal.id}/approve`, b.admin, { send_victim_message: true });
    expect(res.status).toBe(200);
    const msgs = await q(b.c.id);
    expect(msgs.at(-1)).toBe(msgText);
    expect(msgs.length).toBe(2);
    await t!.close();

    // a failed assignment (case already claimed) sends nothing and leaves the proposal open
    const c = await withProposal();
    const other = c.named === c.aliceId ? c.bob : c.alice;
    expect((await post('/assignments', c.admin, { sos_id: c.c.id, responder_id: (await t!.ctx.pool.query("select id from responders where username = $1", [other === c.bob ? 'bob' : 'alice'])).rows[0].id })).status).toBe(201);
    const before2 = await q(c.c.id);
    const bad = await post(`/sos/${c.c.id}/agent/proposals/${c.proposal.id}/approve`, c.admin, { send_victim_message: true });
    expect(bad.status).toBe(409);
    expect(await q(c.c.id)).toEqual(before2);
    expect((await get(`/sos/${c.c.id}/agent`, c.admin)).body.proposal.status).toBe('proposed');
  });

  it('reject, and a new proposal supersedes the older open one', async () => {
    const { alice, admin, c, proposal } = await withProposal();
    const rej = await post(`/sos/${c.id}/agent/proposals/${proposal.id}/reject`, admin, { reason: 'Too far' });
    expect(rej.status).toBe(200);
    expect(rej.body).toMatchObject({ status: 'rejected', decision_note: 'Too far' });
    await post(`/sos/${c.id}/agent/run`, alice);
    await until(async () => (await runRows(t!, c.id)).filter((r) => r.status === 'complete').length === 2);
    await post(`/sos/${c.id}/agent/run`, alice);
    await until(async () => (await runRows(t!, c.id)).filter((r) => r.status === 'complete').length === 3);
    const props = (await t!.ctx.pool.query('select status from agent_proposals where sos_id = $1 order by created_at', [c.id])).rows.map((r) => r.status);
    expect(props).toEqual(['rejected', 'superseded', 'proposed']);
    const older = (await t!.ctx.pool.query("select id from agent_proposals where status = 'superseded'")).rows[0].id;
    expect((await post(`/sos/${c.id}/agent/proposals/${older}/approve`, admin)).status).toBe(409);
  });

  it('proposals expire after TTL; sweep marks them expired; deciding an expired proposal returns 409', async () => {
    const { admin, c, proposal } = await withProposal();
    // Simulate proposal age passing AGENT_PROPOSAL_TTL_S
    await t!.ctx.pool.query("update agent_proposals set created_at = now() - interval '2 hours' where id = $1", [proposal.id]);
    await t!.ctx.agent.sweep();
    const propRow = (await t!.ctx.pool.query('select status from agent_proposals where id = $1', [proposal.id])).rows[0];
    expect(propRow.status).toBe('expired');
    const agentRes = await get(`/sos/${c.id}/agent`, admin);
    expect(agentRes.body.proposal.status).toBe('expired');
    expect((await post(`/sos/${c.id}/agent/proposals/${proposal.id}/approve`, admin)).status).toBe(409);
    expect((await post(`/sos/${c.id}/agent/proposals/${proposal.id}/reject`, admin)).status).toBe(409);
  });

  it('case edit and profile change explicitly trigger agent re-runs', async () => {
    const { alice, dev } = await boot(submitOnly());
    const c = await mkCase(t!, dev);
    await waitRun(t!, c.id);
    const count = async () => (await runRows(t!, c.id)).length;
    expect(await count()).toBe(1);

    // Case edit triggers case_edit
    await t!.request.patch(`/v1/sos/${c.id}`).set(auth(alice)).send({ note: 'Water is rising faster now' });
    await until(async () => (await count()) === 2 && (await runRow(t!, c.id)).status === 'complete');
    expect((await runRow(t!, c.id)).trigger).toBe('case_edit');

    // Profile change triggers case_edit
    await t!.signed(dev, 'PUT', `/v1/devices/${dev.id}/profile`, {
      full_name: 'Elena Updated', preferred_name: 'Elena', birth_year: 1950,
      consent: { accepted: true, version: '2026-11-v1', accepted_at: new Date().toISOString() },
    });
    await until(async () => (await count()) === 3 && (await runRow(t!, c.id)).status === 'complete');
    expect((await runRow(t!, c.id)).trigger).toBe('case_edit');
  });

  it('purge and delete cascade the agent data; counts are reported', async () => {
    const { admin, dev, alice } = await boot(submitOnly());
    const ev = (await post('/events', admin, { name: 'Agent purge', retention_days: 1 })).body;
    const c = await mkCase(t!, dev);
    await waitRun(t!, c.id);
    expect((await t!.ctx.pool.query('select count(*)::int n from agent_proposals')).rows[0].n).toBe(1);
    await post(`/events/${ev.id}/close`, admin);
    const purged = await post(`/events/${ev.id}/purge`, admin);
    expect(purged.status).toBe(200);
    expect(purged.body.purged_agent_runs).toBe(1);
    expect((await t!.ctx.pool.query('select count(*)::int n from agent_runs')).rows[0].n).toBe(0);
    expect((await t!.ctx.pool.query('select count(*)::int n from agent_proposals')).rows[0].n).toBe(0);

    const d2 = await t!.registerDevice();
    const c2 = await mkCase(t!, d2);
    await waitRun(t!, c2.id);
    expect((await t!.request.delete(`/v1/sos/${c2.id}`).set(auth(admin))).status).toBe(204);
    expect((await t!.ctx.pool.query('select count(*)::int n from agent_runs where sos_id = $1', [c2.id])).rows[0].n).toBe(0);
    void alice;
  });
});

describe('facilities ingestion', () => {
  const region = { min_lat: 32.6, min_lng: -97.0, max_lat: 32.95, max_lng: -96.6 };
  const create = async (admin: { token: string }, name = 'Flood') => (await post('/events', admin, { name, region })).body;

  it('Overpass fixture is ingested in the background, with mirror fallback and a 504 retry; any responder can read it', async () => {
    const net = fakeNet(); net.overpass = [504, 504, 200]; // mirror 1 fails twice (retry), mirror 2 answers
    const { admin, carol } = await boot(submitOnly(), { OVERPASS_URLS: 'https://o1.test/api/interpreter,https://o2.test/api/interpreter' }, net);
    const ev = await create(admin);
    await t!.ctx.idle();
    const list = await get(`/events/${ev.id}/facilities`, carol); // volunteers too
    expect(list.status).toBe(200);
    expect(list.body.source).toBe('osm');
    expect(list.body.data.map((f: any) => f.kind).sort()).toEqual(['fire_station', 'hospital', 'shelter', 'shelter']);
    expect(list.body.data.find((f: any) => f.name === 'Parkland Memorial Hospital')).toMatchObject({ osm_id: 'node/1', synthetic: false });
    expect(net.urls.filter((u) => u.includes('o1.test'))).toHaveLength(2);
    expect(net.urls.filter((u) => u.includes('o2.test'))).toHaveLength(1);
    for (const b of net.bodies) expect(decodeURIComponent(b)).not.toMatch(PRECISE);
    expect(decodeURIComponent(net.bodies[0])).toContain('amenity"="hospital');
    // unchanged geofence: no second fetch
    const n = net.urls.length;
    await t!.ctx.facilities.run(ev.id);
    expect(net.urls.length).toBe(n);
    // a changed geofence re-ingests
    await t!.request.patch(`/v1/events/${ev.id}`).set(auth(admin)).send({ region: { ...region, max_lat: 32.96 } });
    await t!.ctx.idle();
    expect(net.urls.length).toBeGreaterThan(n);
    expect((await get(`/events/${ev.id}/facilities`, carol)).status).toBe(200);
    expect((await get(`/events/0192a7d4-1c2e-7000-8a00-0000000000ff/facilities`, carol)).status).toBe(404);
    expect((await t!.request.get(`/v1/events/${ev.id}/facilities`)).status).toBe(401);
  });

  it('gives up after FACILITIES_MAX_ATTEMPTS rounds', async () => {
    const net = fakeNet(); net.overpass = Array(30).fill(504);
    const { admin } = await boot(submitOnly(), { OVERPASS_URLS: 'https://o1.test/api/interpreter', FACILITIES_MAX_ATTEMPTS: '3' }, net);
    const ev = await create(admin);
    await until(async () => (await t!.ctx.pool.query('select facilities_attempts a from events where id = $1', [ev.id])).rows[0].a === 3, 10000);
    const n = net.urls.length;
    await sleep(200);
    expect(net.urls.length).toBe(n); // no further retries
    expect((await t!.ctx.pool.query('select count(*)::int n from facilities')).rows[0].n).toBe(0);
  });

  it('failures retry with backoff and recover; the request never waits', async () => {
    const net = fakeNet(); net.overpass = [504, 504, 504, 504, 200];
    const { admin } = await boot(submitOnly(), { OVERPASS_URLS: 'https://o1.test/api/interpreter', FACILITIES_MAX_ATTEMPTS: '3' }, net);
    const started = Date.now();
    const ev = await create(admin);
    expect(Date.now() - started).toBeLessThan(1500);
    await until(async () => (await t!.ctx.pool.query('select count(*)::int n from facilities where event_id = $1', [ev.id])).rows[0].n > 0, 10000);
    expect((await t!.ctx.pool.query('select facilities_source s from events where id = $1', [ev.id])).rows[0].s).toBe('osm');
  });

  it('DEMO_MODE seeds a synthetic set when Overpass is unavailable; nearest_facilities reads the local table', async () => {
    const net = fakeNet(); net.overpass = Array(40).fill(504);
    const { admin, dev } = await boot(submitOnly(), { DEMO_MODE: 'true', AGENT_ENABLED: 'false', OVERPASS_URLS: 'https://o1.test/api/interpreter', FACILITIES_MAX_ATTEMPTS: '2' }, net);
    const ev = await create(admin);
    await until(async () => (await t!.ctx.pool.query('select facilities_source s from events where id = $1', [ev.id])).rows[0].s === 'synthetic_demo', 10000);
    const list = (await get(`/events/${ev.id}/facilities`, admin)).body;
    expect(list.source).toBe('synthetic_demo');
    expect(list.data).toHaveLength(6);
    expect(list.data.every((f: any) => f.synthetic)).toBe(true);
    const c = await mkCase(t!, dev, { lat: 32.78, lng: -96.8 });
    const row = await t!.ctx.db.selectFrom('sos').selectAll().where('id', '=', c.id).executeTakeFirstOrThrow();
    const r = await execTool(t!.ctx, row, 'nearest_facilities', '{"kind":"hospital"}', Date.now() + 2000);
    const fac = (r.result as any).facilities;
    expect(fac.length).toBeGreaterThan(0);
    expect(fac.every((f: any) => f.kind === 'hospital')).toBe(true);
    expect(fac[0].distance_km).toBeLessThanOrEqual(fac.at(-1).distance_km);
    expect(JSON.stringify(fac)).not.toMatch(PRECISE);
    void EXACT;
  });

  it('with external tools off, the demo still gets its synthetic set and non-demo gets nothing', async () => {
    const { admin } = await boot(submitOnly(), { AGENT_EXTERNAL_TOOLS: 'false', DEMO_MODE: 'true', AGENT_ENABLED: 'false' });
    const ev = await create(admin);
    await t!.ctx.idle();
    expect((await get(`/events/${ev.id}/facilities`, admin)).body.source).toBe('synthetic_demo');
    await t!.close();
    const b = await boot(submitOnly(), { AGENT_EXTERNAL_TOOLS: 'false', AGENT_ENABLED: 'false' });
    const ev2 = await create(b.admin, 'Plain');
    await t!.ctx.idle();
    expect((await get(`/events/${ev2.id}/facilities`, b.admin)).body).toMatchObject({ data: [], source: null });
  });
});
