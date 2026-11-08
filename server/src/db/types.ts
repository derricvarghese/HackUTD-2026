import type { ColumnType } from 'kysely';

type Table<R, Req extends keyof R> = {
  [K in keyof R]: K extends Req ? R[K] : ColumnType<R[K], R[K] | undefined, R[K] | undefined>;
};
type TS = Date;

export interface EventRow { facilities_bbox: string | null; facilities_fetched_at: TS | null; facilities_attempts: number; facilities_source: string | null; id: string; name: string; status: 'active' | 'closed' | 'purged'; region: unknown | null; retention_days: number; heartbeat_interval_s: number; silence_threshold_s: number; synthetic: boolean; closed_at: TS | null; purge_at: TS | null; purged_at: TS | null; created_at: TS; updated_at: TS }
export interface DeviceRow { id: string; public_key: string; sender_hash: string; platform: string; app_version: string | null; display_name: string | null; push_token: string | null; flagged: boolean; flag_reason: string | null; synthetic: boolean; last_seen_at: TS | null; last_heartbeat_at: TS | null; heartbeat_status: string; last_transport: string | null; last_network: string | null; last_battery: number | null; last_peers_nearby: number | null; last_gateway: boolean | null; created_at: TS; updated_at: TS }
export interface ResponderRow { id: string; username: string; password_hash: string; name: string; role: 'responder' | 'volunteer' | 'admin'; skills: string[]; organization: string | null; phone: string | null; available: boolean; active: boolean; lat: number | null; lng: number | null; last_seen_at: TS | null; in_app: boolean; last_app_seen_at: TS | null; location_updated_at: TS | null; available_manual: boolean | null; presence_pinned: boolean; created_at: TS; updated_at: TS }
export interface RefreshTokenRow { id: string; responder_id: string; token_hash: string; expires_at: TS; revoked: boolean; created_at: TS; updated_at: TS }
export type TriageStatus = 'provisional' | 'pending' | 'complete' | 'failed';
export interface SosRow {
  id: string; event_id: string | null; device_id: string | null; sender_hash: string; channel: 'mesh' | 'app';
  category: 'injured' | 'trapped' | 'need_water_meds' | 'safe' | 'other';
  status: 'reported' | 'assigned' | 'en_route' | 'on_scene' | 'resolved' | 'merged' | 'closed';
  lat: number | null; lng: number | null; geohash7: string | null; approx_lat: number; approx_lng: number;
  text: string | null; people_count: number | null; trapped: boolean; water_rising: boolean; injured: boolean; accuracy_m: number | null;
  score: number; score_override: number | null; confidence: 'low' | 'medium' | 'high';
  silent: boolean; silent_since: TS | null; merged_into: string | null; duplicate_count: number; version: number;
  last_heard_at: TS; hop_count: number; max_hops: number; hop_path: string[]; gateway_device_id: string | null;
  original_created_at: TS; received_at: TS; has_voice_note: boolean; synthetic: boolean; silence_boost: number; heartbeat_boost: number; contact_boost: number; urgent_boost: number; welfare_missed: number; image_hint: number | null; profile_summary: unknown | null; created_at: TS; updated_at: TS;
  triage_status: TriageStatus; triage_attempts: number; triage_sweeps: number; triage_gen: number; triage_updated_at: TS | null; triage_requested_at: TS; triage_next_at: TS; triage_claimed_at: TS | null;
}
export interface SosReportRow { id: string; sos_id: string; channel: string; envelope: unknown | null; text: string | null; hop_count: number; max_hops: number; hop_path: string[]; gateway_device_id: string | null; original_created_at: TS | null; received_at: TS; created_at: TS; updated_at: TS }
export interface TriageResultRow { id: string; sos_id: string; score: number; confidence: string; summary: string | null; tier: string | null; reasons: unknown; extracted: unknown; llm_used: boolean; model: string | null; scored_at: TS; created_at: TS; updated_at: TS }
export interface SosEventRow { id: string; sos_id: string; type: string; actor_kind: 'system' | 'responder' | 'victim'; actor_id: string | null; data: unknown; at: TS; created_at: TS; updated_at: TS }
export interface CheckinRow { id: string; sos_id: string; channel: string; message: string | null; sent_at: TS; deadline_at: TS; responded_at: TS | null; response: string | null; response_text: string | null; kind: string; attempt: number; missed: boolean; cancelled: boolean; reminder_count: number; last_reminded_at: TS | null; created_at: TS; updated_at: TS }
export interface AssignmentRow { id: string; sos_id: string; responder_id: string; status: 'assigned' | 'en_route' | 'on_scene' | 'resolved' | 'released' | 'cancelled'; eta_minutes: number | null; eta_at: TS | null; outcome: string | null; resolved_at: TS | null; created_at: TS; updated_at: TS }
export interface HeartbeatRow { id: string; device_id: string; event_id: string | null; sent_at: TS; received_at: TS; approx_lat: number; approx_lng: number; radius_m: number; battery_pct: number | null; charging: boolean | null; moving: boolean | null; seq: number | null; transport: string | null; network: string | null; peers_nearby: number | null; gateway: boolean | null; open_sos_ids: unknown | null; hop_count: number; hop_path: string[]; created_at: TS; updated_at: TS }
export interface ProfileRow { device_id: string; full_name: string; name_norm: string; preferred_name: string | null; birth_year: number | null; vuln_flags: string[]; enc: Buffer; enc_version: number; consent_version: string; consent_accepted_at: TS; profile_version: number; synthetic: boolean; created_at: TS; updated_at: TS }
export interface RejectionRow { id: string; reason: string; device_id: string | null; envelope_id: string | null; created_at: TS; updated_at: TS }

export interface SilentDeviceRow { id: string; device_id: string; event_id: string | null; status: 'quiet' | 'distress'; neighbors_active: number; open_sos_id: string | null; priority_score: number; reason: string | null; acknowledged: boolean; resolved_at: TS | null; flagged_at: TS; note: string | null; created_at: TS; updated_at: TS }
export interface DeadzoneRow { id: string; event_id: string | null; center_lat: number; center_lng: number; radius_m: number; status: 'open' | 'being_checked' | 'dismissed'; reason: string | null; last_activity_at: TS | null; neighbor_case_count: number; detected_at: TS; cell_key: string | null; note: string | null; created_at: TS; updated_at: TS }
export interface MeshOutboxRow { id: string; kind: 'delivered' | 'checkin_request' | 'status_update'; sos_id: string | null; checkin_id: string | null; body: unknown; envelope: unknown; max_hops: number; expires_at: TS; delivered: boolean; created_at: TS; updated_at: TS }
export interface VoiceNoteRow { id: string; sos_id: string; mime: string; size_bytes: number; data: Buffer | null; transcript: string | null; created_at: TS; updated_at: TS }
export interface CaseImageRow { id: string; sos_id: string; device_id: string | null; uploaded_by_kind: 'device' | 'responder'; responder_id: string | null; content_type: 'image/jpeg' | 'image/png'; bytes: number; width: number; height: number; caption: string | null; data: Buffer; created_at: TS }
export interface FacilityRow { id: string; event_id: string; kind: 'hospital' | 'fire_station'; name: string; lat: number; lng: number; osm_id: string | null; tags: unknown; created_at: TS }
export interface AgentRunRow { id: string; sos_id: string; status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'; trigger: string; model: string | null; priority: number; attempts: number; steps: unknown; assessment: unknown | null; signals: unknown | null; error: string | null; tokens: unknown | null; claimed_at: TS | null; started_at: TS | null; finished_at: TS | null; duration_ms: number | null; created_at: TS; updated_at: TS }
export interface AgentProposalRow { id: string; run_id: string; sos_id: string; kind: string; responder_id: string | null; eta_minutes: number | null; equipment: unknown; facility: unknown | null; victim_message: string | null; notes: string | null; status: 'proposed' | 'approved' | 'rejected' | 'superseded' | 'expired'; decided_by: string | null; decided_at: TS | null; decision_note: string | null; created_at: TS; updated_at: TS }

export interface Database {
  events: Table<EventRow, 'name'>;
  devices: Table<DeviceRow, 'public_key' | 'sender_hash'>;
  responders: Table<ResponderRow, 'username' | 'password_hash' | 'name' | 'role'>;
  refresh_tokens: Table<RefreshTokenRow, 'responder_id' | 'token_hash' | 'expires_at'>;
  sos: Table<SosRow, 'id' | 'sender_hash' | 'channel' | 'category' | 'approx_lat' | 'approx_lng' | 'last_heard_at' | 'original_created_at' | 'received_at' | 'created_at'>;
  sos_reports: Table<SosReportRow, 'sos_id' | 'channel'>;
  triage_results: Table<TriageResultRow, 'sos_id' | 'score' | 'confidence'>;
  sos_events: Table<SosEventRow, 'sos_id' | 'type'>;
  checkins: Table<CheckinRow, 'sos_id' | 'deadline_at'>;
  assignments: Table<AssignmentRow, 'sos_id' | 'responder_id'>;
  heartbeats: Table<HeartbeatRow, 'device_id' | 'sent_at' | 'approx_lat' | 'approx_lng'>;
  rejections: Table<RejectionRow, 'reason'>;
  silent_devices: Table<SilentDeviceRow, 'device_id' | 'status'>;
  deadzones: Table<DeadzoneRow, 'center_lat' | 'center_lng'>;
  mesh_outbox: Table<MeshOutboxRow, 'kind' | 'envelope' | 'expires_at'>;
  voice_notes: Table<VoiceNoteRow, 'sos_id' | 'mime' | 'size_bytes'>;
  case_images: Table<CaseImageRow, 'id' | 'sos_id' | 'uploaded_by_kind' | 'content_type' | 'bytes' | 'width' | 'height' | 'data'>;
  facilities: Table<FacilityRow, 'event_id' | 'kind' | 'name' | 'lat' | 'lng'>;
  agent_runs: Table<AgentRunRow, 'sos_id' | 'trigger'>;
  agent_proposals: Table<AgentProposalRow, 'run_id' | 'sos_id'>;
  profiles: Table<ProfileRow, 'device_id' | 'full_name' | 'name_norm' | 'enc' | 'consent_version' | 'consent_accepted_at'>;
}
