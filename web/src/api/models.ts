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

export type AgentStep = Schemas['AgentStep'];
export type AgentAssessment = Schemas['AgentAssessment'];
export type AgentRecommendation = Schemas['AgentRecommendation'];
export type AgentProposal = Schemas['AgentProposal'];
export type AgentRun = Schemas['AgentRun'];
export type AgentRunSummary = Schemas['AgentRunSummary'];
export type AgentProposalApprove = Schemas['AgentProposalApprove'];
export type AgentProposalReject = Schemas['AgentProposalReject'];
export type AgentProposalDecision = Schemas['AgentProposalDecision'];
export type FacilityKind = Schemas['FacilityKind'];
export type Facility = Schemas['Facility'];
export type FacilityList = Schemas['FacilityList'];
export type WsEventAgentStep = Schemas['WsEventAgentStep'];
export type WsEventAgentUpdated = Schemas['WsEventAgentUpdated'];
