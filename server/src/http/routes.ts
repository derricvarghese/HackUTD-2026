import { Router } from 'express';
import type { Request } from 'express';
import type { Ctx } from '../ctx';
import { hopLimitsList } from '../domain/hops';
import { forbidden, invalid, unauthorized } from '../errors';
import * as auth from '../services/auth';
import * as devices from '../services/devices';
import * as sos from '../services/sos';
import * as merge from '../services/merge';
import * as assignments from '../services/assignments';
import * as responders from '../services/responders';
import * as checkins from '../services/checkins';
import * as events from '../services/events';
import * as heartbeats from '../services/heartbeats';
import * as outbox from '../services/outbox';
import * as mesh from '../services/mesh';
import * as map from '../services/map';
import * as voice from '../services/voice';
import * as images from '../services/images';
import * as profiles from '../services/profiles';
import { triageHealth, VERSION } from '../services/health';
import { activeEventRow, eventTimers, toEvent } from '../services/events';
import { processBatch } from '../services/ingest';
import { senderHash } from '../services/devices';
import { asBool, asInt, asList, limitOf, q, str } from './helpers';
import { requireDevice, requireResponder, requireRole, viewerOf } from './types';

export function buildRoutes(ctx: Ctx): Router {
  const r = Router();
  const ip = (req: Request) => req.ip ?? 'unknown';
  const actorOf = (req: Request) => { const x = requireResponder(req); return { id: x.id, role: x.role }; };

  // ---------------------------------------------------------------- System
  r.get('/health', async (_req, res) => {
    await ctx.pool.query('select 1');
    res.json({ status: 'ok', time: new Date().toISOString(), version: VERSION, triage: { ...(await triageHealth(ctx)), ...(await ctx.aiTriage.stats()) } });
  });
  r.get('/server-info', async (_req, res) => {
    const ev = await activeEventRow(ctx);
    res.json({
      server_time: new Date().toISOString(),
      event: ev ? await toEvent(ctx, ev) : null,
      encryption_public_key: ctx.keys.encPublicB64,
      signing_public_key: ctx.keys.signPublicB64,
      hop_limits: hopLimitsList(),
      checkin_interval_seconds: eventTimers(ctx.cfg, ev).checkinS,
      checkin_intervals_seconds: { critical: ctx.cfg.CHECKIN_INTERVAL_CRITICAL_S, high: ctx.cfg.CHECKIN_INTERVAL_HIGH_S, normal: ctx.cfg.CHECKIN_INTERVAL_S },
      checkin_window_seconds: ctx.cfg.CHECKIN_WINDOW_S,
      checkin_reminder_seconds: ctx.cfg.CHECKIN_REMINDER_S,
      heartbeat_interval_seconds: eventTimers(ctx.cfg, ev).heartbeatS,
      silence_threshold_seconds: eventTimers(ctx.cfg, ev).silenceS,
      gateway_upload_max_batch: 500,
      profile_required: ctx.cfg.PROFILE_REQUIRED,
      profile_consent_version: ctx.cfg.PROFILE_CONSENT_VERSION,
    });
  });

  // ---------------------------------------------------------------- Auth
  r.post('/auth/login', async (req, res) => res.json(await auth.login(ctx, ip(req), req.body.username, req.body.password)));
  r.post('/auth/refresh', async (req, res) => res.json(await auth.refresh(ctx, req.body.refresh_token)));
  r.post('/auth/logout', async (req, res) => {
    await auth.logout(ctx, requireResponder(req).id, req.body?.refresh_token);
    res.status(204).end();
  });
  r.get('/auth/me', async (req, res) => res.json(await responders.getResponderView(ctx, requireResponder(req).id).catch(() => { throw unauthorized('Account no longer active'); })));

  // ---------------------------------------------------------------- Devices
  r.post('/devices', async (req, res) => {
    const [d, created] = await devices.registerDevice(ctx, ip(req), req.body);
    res.status(created ? 201 : 200).json(d);
  });
  const deviceActor = (req: Request): devices.Actor =>
    req.responder ? { kind: 'responder', id: req.responder.id, role: req.responder.role } : { kind: 'device', id: requireDevice(req).id };
  r.get('/devices', async (req, res) => {
    requireRole(req, 'responder', 'admin');
    res.json(await devices.listDevices(ctx, { limit: limitOf(req), cursor: str(q(req).cursor), flagged: asBool(q(req).flagged) }));
  });
  r.get('/devices/:deviceId', async (req, res) => {
    const a = deviceActor(req);
    if (a.kind === 'device' && a.id !== req.params.deviceId) throw forbidden('A device can only read itself');
    res.json(await devices.getDevice(ctx, req.params.deviceId));
  });
  r.patch('/devices/:deviceId', async (req, res) => res.json(await devices.updateDevice(ctx, req.params.deviceId, req.body, deviceActor(req))));
  r.delete('/devices/:deviceId', async (req, res) => { await devices.deleteDevice(ctx, req.params.deviceId, deviceActor(req)); res.status(204).end(); });

  // ---------------------------------------------------------------- Profiles (personal data: nothing here is ever logged)
  r.put('/devices/:deviceId/profile', async (req, res) => {
    const out = await profiles.putProfile(ctx, req.params.deviceId, requireDevice(req).id, req.body, req.header('if-match'));
    res.status(out.created ? 201 : 200).setHeader('ETag', profiles.etag(out.profile.profile_version));
    res.json(out.profile);
  });
  r.get('/devices/:deviceId/profile', async (req, res) => {
    const p = await profiles.getProfile(ctx, req.params.deviceId, viewerOf(req));
    if (p.view === 'full') res.setHeader('ETag', profiles.etag(p.profile_version));
    res.json(p);
  });
  r.delete('/devices/:deviceId/profile', async (req, res) => { await profiles.deleteProfile(ctx, req.params.deviceId, viewerOf(req)); res.status(204).end(); });

  // ---------------------------------------------------------------- SOS
  r.post('/sos', async (req, res) => {
    const creator: sos.Creator = req.device
      ? { kind: 'device', id: req.device.id, senderHash: req.device.senderHash }
      : { kind: 'responder', id: requireResponder(req).id, senderHash: senderHash(ctx, `responder:${requireResponder(req).id}`) };
    const out = await sos.createSos(ctx, req.body, creator, viewerOf(req));
    res.status(out.created ? 201 : 200).json(out.sos);
  });
  r.get('/sos', async (req, res) => {
    requireResponder(req);
    const x = q(req);
    res.json(await sos.listSos(ctx, {
      limit: limitOf(req), cursor: str(x.cursor), status: asList(x.status), channel: str(x.channel), category: str(x.category),
      min_score: x.min_score === undefined ? undefined : asInt(x.min_score, 0), silent: asBool(x.silent), assigned_to: str(x.assigned_to),
      bbox: str(x.bbox), updated_since: str(x.updated_since), sort: str(x.sort), q: str(x.q),
    }, viewerOf(req)));
  });
  r.post('/sos/batch', async (req, res) => {
    const dev = requireDevice(req);
    res.json(await processBatch(ctx, req.body.envelopes, dev.id));
  });
  r.get('/sos/:sosId', async (req, res) => { requireResponder(req); res.json(await sos.getSosDetail(ctx, req.params.sosId, viewerOf(req))); });
  r.patch('/sos/:sosId', async (req, res) => res.json(await sos.updateSos(ctx, req.params.sosId, req.body, actorOf(req), viewerOf(req))));
  r.delete('/sos/:sosId', async (req, res) => { await sos.deleteSos(ctx, req.params.sosId, actorOf(req)); res.status(204).end(); });
  r.post('/sos/:sosId/retriage', async (req, res) => res.json(await sos.retriage(ctx, req.params.sosId, actorOf(req), viewerOf(req))));
  r.get('/sos/:sosId/events', async (req, res) => { requireResponder(req); res.json({ data: await sos.listEventsFor(ctx, req.params.sosId) }); });
  r.post('/sos/:sosId/merge', async (req, res) => {
    const a = requireRole(req, 'responder', 'admin');
    await merge.manualMerge(ctx, req.params.sosId, req.body.duplicate_ids, { kind: 'responder', id: a.id });
    res.json(await sos.getSosView(ctx, req.params.sosId, viewerOf(req)));
  });
  r.post('/sos/:sosId/unmerge', async (req, res) => {
    const a = requireRole(req, 'responder', 'admin');
    await merge.unmerge(ctx, req.params.sosId, req.body.report_id, { kind: 'responder', id: a.id });
    res.json(await sos.getSosView(ctx, req.params.sosId, viewerOf(req)));
  });
  r.get('/sos/:sosId/status', async (req, res) => {
    const st = await sos.publicStatus(ctx, req.params.sosId, requireDevice(req).id);
    await outbox.retireStatusMessages(ctx, req.params.sosId); // the phone has the latest status now; stop broadcasting older ones
    res.json(st);
  });

  // ---------------------------------------------------------------- Voice notes
  r.put('/sos/:sosId/voice-note', async (req, res) => {
    await voice.putVoiceNote(ctx, req.params.sosId, requireDevice(req).id, req.headers['content-type'] ?? '', req.body);
    res.status(204).end();
  });
  r.get('/sos/:sosId/voice-note', async (req, res) => {
    const v = await voice.getVoiceNote(ctx, req.params.sosId, requireResponder(req));
    res.status(200).type(v.mime).send(v.data);
  });
  r.delete('/sos/:sosId/voice-note', async (req, res) => { await voice.deleteVoiceNote(ctx, req.params.sosId, requireResponder(req)); res.status(204).end(); });

  // ---------------------------------------------------------------- Case images (bytes and captions are never logged)
  const imageActor = (req: Request): images.ImageActor =>
    req.responder ? { kind: 'responder', id: req.responder.id, role: req.responder.role } : { kind: 'device', id: requireDevice(req).id };
  r.put('/sos/:sosId/images/:imageId', async (req, res) => {
    const out = await images.putImage(ctx, req.params.sosId, req.params.imageId, imageActor(req), req.headers['content-type'], req.body, str(q(req).caption));
    res.status(out.created ? 201 : 200).json(out.image);
  });
  r.get('/sos/:sosId/images', async (req, res) => { res.json({ data: await images.listImages(ctx, req.params.sosId, imageActor(req)) }); });
  r.get('/sos/:sosId/images/:imageId', async (req, res) => {
    const img = await images.getImageBytes(ctx, req.params.sosId, req.params.imageId, imageActor(req));
    res.status(200).set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(img.data.length) }).end(img.data);
  });
  r.delete('/sos/:sosId/images/:imageId', async (req, res) => { await images.deleteImage(ctx, req.params.sosId, req.params.imageId, imageActor(req)); res.status(204).end(); });

  // ---------------------------------------------------------------- Check-ins
  r.get('/sos/:sosId/checkins', async (req, res) => { requireResponder(req); res.json({ data: await checkins.listCheckins(ctx, req.params.sosId) }); });
  r.post('/sos/:sosId/checkins', async (req, res) => res.status(201).json(await checkins.createCheckin(ctx, req.params.sosId, req.body, requireResponder(req))));
  r.get('/checkins/pending', async (req, res) => res.json({ data: await checkins.listPending(ctx, requireDevice(req).id) }));
  r.get('/checkins/:checkinId', async (req, res) => {
    const v = viewerOf(req);
    if (v.kind === 'anon') throw unauthorized();
    res.json(await checkins.getCheckin(ctx, req.params.checkinId, v));
  });
  r.patch('/checkins/:checkinId', async (req, res) => res.json(await checkins.respondCheckin(ctx, req.params.checkinId, requireDevice(req).id, req.body)));
  r.delete('/checkins/:checkinId', async (req, res) => { await checkins.cancelCheckin(ctx, req.params.checkinId, requireResponder(req)); res.status(204).end(); });

  // ---------------------------------------------------------------- Assignments
  r.post('/assignments', async (req, res) => res.status(201).json(await assignments.createAssignment(ctx, req.body, actorOf(req))));
  r.get('/assignments', async (req, res) => {
    const x = q(req);
    res.json(await assignments.listAssignments(ctx, { limit: limitOf(req), cursor: str(x.cursor), responder_id: str(x.responder_id), sos_id: str(x.sos_id), status: asList(x.status) }, actorOf(req)));
  });
  r.get('/assignments/:assignmentId', async (req, res) => res.json(await assignments.getAssignment(ctx, req.params.assignmentId, actorOf(req))));
  r.patch('/assignments/:assignmentId', async (req, res) => res.json(await assignments.updateAssignment(ctx, req.params.assignmentId, req.body, actorOf(req))));
  r.delete('/assignments/:assignmentId', async (req, res) => { await assignments.releaseAssignment(ctx, req.params.assignmentId, actorOf(req)); res.status(204).end(); });

  // ---------------------------------------------------------------- Responders
  r.get('/responders', async (req, res) => {
    requireResponder(req);
    const x = q(req);
    res.json(await responders.listResponders(ctx, { limit: limitOf(req), cursor: str(x.cursor), skill: str(x.skill), available: asBool(x.available) }));
  });
  r.post('/responders', async (req, res) => { requireRole(req, 'admin'); res.status(201).json(await responders.createResponder(ctx, req.body)); });
  r.get('/responders/:responderId', async (req, res) => { requireResponder(req); res.json(await responders.getResponderView(ctx, req.params.responderId)); });
  r.patch('/responders/:responderId', async (req, res) => res.json(await responders.updateResponder(ctx, req.params.responderId, req.body, actorOf(req))));
  r.delete('/responders/:responderId', async (req, res) => { await responders.deactivateResponder(ctx, req.params.responderId, actorOf(req)); res.status(204).end(); });

  // ---------------------------------------------------------------- Mesh
  r.get('/mesh/stats', async (req, res) => { requireResponder(req); res.json(await mesh.cachedMeshStats(ctx, asInt(q(req).window_minutes, 60))); });
  r.get('/mesh/receipts', async (req, res) => { requireDevice(req); res.json({ data: await mesh.listReceipts(ctx, { since: str(q(req).since), limit: limitOf(req) }) }); });
  r.get('/mesh/outbox', async (req, res) => { requireDevice(req); res.json({ data: await outbox.listOutbox(ctx, { since: str(q(req).since), limit: limitOf(req) }) }); });
  r.post('/mesh/simulate', async (req, res) => { mesh.requireDemo(ctx); requireRole(req, 'responder', 'admin'); res.status(201).json(await mesh.simulate(ctx, req.body, viewerOf(req))); });
  r.post('/mesh/seed', async (req, res) => { mesh.requireDemo(ctx); requireRole(req, 'responder', 'admin'); res.status(201).json(await mesh.seed(ctx, req.body)); });
  r.delete('/mesh/seed', async (req, res) => { mesh.requireDemo(ctx); requireRole(req, 'responder', 'admin'); await mesh.clearSynthetic(ctx); res.status(204).end(); });

  // ---------------------------------------------------------------- Heartbeats
  r.post('/heartbeats', async (req, res) => res.status(202).json(await heartbeats.postHeartbeat(ctx, requireDevice(req).id, req.body)));
  r.get('/heartbeats', async (req, res) => {
    requireResponder(req);
    const x = q(req);
    res.json(await heartbeats.listHeartbeats(ctx, { limit: limitOf(req), cursor: str(x.cursor), device_id: str(x.device_id), since: str(x.since) }));
  });
  r.get('/heartbeats/silent', async (req, res) => {
    requireResponder(req);
    const x = q(req);
    res.json(await heartbeats.listSilent(ctx, { limit: limitOf(req), cursor: str(x.cursor), status: asList(x.status), bbox: str(x.bbox), include_acknowledged: asBool(x.include_acknowledged) }));
  });
  r.get('/heartbeats/silent/:deviceId', async (req, res) => { requireResponder(req); res.json(await heartbeats.getSilent(ctx, req.params.deviceId)); });
  r.patch('/heartbeats/silent/:deviceId', async (req, res) => res.json(await heartbeats.updateSilent(ctx, req.params.deviceId, req.body, requireResponder(req))));
  r.post('/heartbeats/silent/:deviceId/promote', async (req, res) => {
    const id = await heartbeats.promoteSilent(ctx, req.params.deviceId, requireResponder(req));
    res.status(201).json(await sos.getSosView(ctx, id, viewerOf(req)));
  });

  // ---------------------------------------------------------------- Events
  r.get('/events', async (req, res) => {
    requireResponder(req);
    const x = q(req);
    res.json(await events.listEvents(ctx, { limit: limitOf(req), cursor: str(x.cursor), status: str(x.status) as 'active' | 'closed' | 'purged' | undefined }));
  });
  r.post('/events', async (req, res) => { requireRole(req, 'admin'); res.status(201).json(await events.createEvent(ctx, req.body)); });
  r.get('/events/:eventId', async (req, res) => { requireResponder(req); res.json(await events.getEvent(ctx, req.params.eventId)); });
  r.patch('/events/:eventId', async (req, res) => { requireRole(req, 'admin'); res.json(await events.updateEvent(ctx, req.params.eventId, req.body)); });
  r.delete('/events/:eventId', async (req, res) => { requireRole(req, 'admin'); await events.deleteEvent(ctx, req.params.eventId); res.status(204).end(); });
  r.post('/events/:eventId/close', async (req, res) => { requireRole(req, 'admin'); res.json(await events.closeEvent(ctx, req.params.eventId)); });
  r.post('/events/:eventId/purge', async (req, res) => { requireRole(req, 'admin'); res.json(await events.purgeEvent(ctx, req.params.eventId)); });

  // ---------------------------------------------------------------- Map
  r.get('/map/heat', async (req, res) => {
    requireResponder(req);
    const x = q(req);
    if (!str(x.bbox)) throw invalid('bbox is required', { bbox: 'required' });
    res.json({ data: await map.heat(ctx, str(x.bbox)!, x.cell_km === undefined ? 1 : Number(x.cell_km)) });
  });
  r.get('/map/deadzones', async (req, res) => { requireResponder(req); res.json({ data: await map.listDeadzones(ctx, str(q(req).bbox)) }); });
  r.patch('/map/deadzones/:deadzoneId', async (req, res) => res.json(await map.updateDeadzone(ctx, req.params.deadzoneId, req.body, requireResponder(req))));

  return r;
}
