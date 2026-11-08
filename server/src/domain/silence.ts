import { haversineM } from './geo';

/**
 * Lost-heartbeat state machine for the silent-device list (design 6.4). Pure: all inputs are explicit, `now` is injected.
 * quiet = threshold missed, probably no connectivity; distress = threshold missed while neighbours still report, or an open SOS exists.
 */
export type HbState = 'active' | 'quiet' | 'distress';

export interface SilenceInput {
  now: number;
  lastHeartbeatAt: number;
  thresholdS: number;
  /** other devices still heartbeating in the same or adjacent ~1 km cells */
  neighborsActive: number;
  neighborK: number;
  hasOpenSos: boolean;
  batteryPct: number | null;
  charging: boolean | null;
  moving: boolean | null;
  /** the device sent a `safe` message: going quiet is expected */
  safeMessage: boolean;
}
export interface SilenceVerdict {
  state: HbState;
  silentForS: number;
  priority: number;
  reason: string;
  /** battery <= 3% and not charging: probably just a dead phone, priority lowered but never dropped */
  lowBattery: boolean;
}

export const LOW_BATTERY_PCT = 3;

export function evaluateSilence(i: SilenceInput): SilenceVerdict {
  const silentForS = Math.max(0, Math.floor((i.now - i.lastHeartbeatAt) / 1000));
  const lowBattery = i.batteryPct != null && i.batteryPct <= LOW_BATTERY_PCT && i.charging === false;
  if (silentForS < i.thresholdS || i.safeMessage) {
    return { state: 'active', silentForS, priority: 0, reason: i.safeMessage ? 'Device reported safe' : 'Heard recently', lowBattery };
  }
  const crowded = i.neighborsActive >= i.neighborK;
  // a dying battery explains silence on its own; only an open SOS keeps it in distress
  const distress = i.hasOpenSos || (crowded && !lowBattery);
  let priority = distress ? 60 : 30;
  priority += Math.min(20, i.neighborsActive * 2);
  if (i.hasOpenSos) priority += 20;
  if (i.moving) priority += 5;
  priority += Math.min(10, Math.floor((silentForS - i.thresholdS) / 3600) * 2);
  if (lowBattery) priority -= 30;
  priority = Math.max(0, Math.min(100, priority));
  const mins = Math.round(silentForS / 60);
  const parts = [`Lost contact: no heartbeat for ${mins} min (device probably has no connectivity)`];
  if (i.neighborsActive > 0) parts.push(`${i.neighborsActive} neighbour${i.neighborsActive === 1 ? '' : 's'} in the area still reporting`);
  if (i.hasOpenSos) parts.push('has an open SOS');
  if (i.batteryPct != null) parts.push(`battery was ${i.batteryPct}%${i.charging ? ' (charging)' : ''}`);
  if (lowBattery) parts.push('likely dead battery, priority lowered');
  return { state: distress ? 'distress' : 'quiet', silentForS, priority, reason: parts.join('; '), lowBattery };
}

/** Devices within ~1.6 km (same or adjacent grid cell) that are still heartbeating. */
export function countNeighbors(me: { lat: number; lng: number }, active: { lat: number; lng: number }[], radiusM = 1600): number {
  let n = 0;
  for (const a of active) if (haversineM(me.lat, me.lng, a.lat, a.lng) <= radiusM) n++;
  return n;
}
