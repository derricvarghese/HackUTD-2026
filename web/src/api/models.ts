import type { Schemas } from './client';

export type Sos = Schemas['Sos'];
export type SosDetail = Schemas['SosDetail'];
export type SosStatus = Schemas['SosStatus'];
export type Category = Schemas['Category'];
export type Tier = Schemas['Tier'];
export type Confidence = Schemas['Confidence'];
export type TriageReason = Schemas['TriageReason'];
export type Triage = Schemas['Triage'];
export type SosEvent = Schemas['SosEvent'];
export type Checkin = Schemas['Checkin'];
export type Assignment = Schemas['Assignment'];
export type AssignmentSummary = Schemas['AssignmentSummary'];
export type AssignmentStatus = Schemas['AssignmentStatus'];
export type Responder = Schemas['Responder'];
export type Role = Schemas['Role'];
export type SilentDevice = Schemas['SilentDevice'];
export type Deadzone = Schemas['Deadzone'];
export type MeshStats = Schemas['MeshStats'];
export type ServerInfo = Schemas['ServerInfo'];
export type AppEvent = Schemas['Event'];
export type WsFrame = Schemas['WsFrame'];
export type HopInfo = Schemas['HopInfo'];
export type ProfilePublic = Schemas['ProfilePublic'];
export type ProfileFull = Schemas['ProfileFull'];
export type AgeRange = Schemas['AgeRange'];
export type VulnerabilityFlag = Schemas['VulnerabilityFlag'];
export type ApproxLocation = Schemas['ApproxLocation'];
export type LatLng = Schemas['LatLng'];

export interface HeatCell {
  lat: number;
  lng: number;
  count: number;
  max_score: number;
}

export const OPEN_STATUSES: SosStatus[] = ['reported', 'assigned', 'en_route', 'on_scene'];
export const ACTIVE_ASSIGNMENT: AssignmentStatus[] = ['assigned', 'en_route', 'on_scene'];

export type CaseImage = Schemas['CaseImage'];
export type TriageStatus = Schemas['TriageStatus'];
export type Connectivity = Schemas['Connectivity'];
export type ContactState = Schemas['ContactState'];
export type Health = import('./client').Res<'/health', 'get'>;
