export interface EventPayload {
  event_id: string;
  proof: string;
  job_url?: string;
  job_title?: string;
  company?: string;
  observed_at?: string;
  profile_id?: string;
  profile_name?: string;
  website_job_id?: string;
  removal_event?: string;
  code?: string;
  quote?: string;
  detail?: string;
}
export interface EventResult {
  event_id?: string;
  state: string;
  retryable?: boolean;
  removal_detail?: string;
  expires_at?: number;
  job_id?: string;
  application_id?: string;
}
export interface SyncState {
  deviceId: string;
  outbox: Array<{
    payload: EventPayload;
    attempts: number;
    next: number;
    availabilityKey?: string;
  }>;
  token?: string;
  profileToken?: string;
  disabled?: boolean;
  connected?: boolean;
  privateDeviceId?: string;
  privateConnectionVersion?: string;
  error?: string;
  lastSynced?: number;
  needsConfirmation?: number;
  seen?: Record<string, number>;
  availability?: Record<
    string,
    {
      payload: EventPayload;
      tabId: number;
      at: number;
      result?: EventResult;
      undo?: EventPayload;
    }
  >;
}
export interface AnswerTask {
  id: string;
  created: number;
}
export interface HistoryField {
  id: string;
  question: string;
  kind: string;
  required: boolean;
  hasValue: boolean;
  invalid: boolean;
  status: string;
  attempts: number;
  value?: string;
  decision?: Record<string, string | number>;
  trace?: Record<string, string | number | string[]>;
}
export interface HistoryEvent {
  at: number;
  document: string;
  type: string;
  fieldId?: string;
  phase?: string;
  build?: string;
}
export interface HistorySnapshot {
  at: number;
  document: string;
  phase: string;
  step: string;
  fields: HistoryField[];
  unrecognized?: Array<{ question: string; reason: string; structure: string }>;
}
export interface CaseRetention {
  revision: number;
  unresolvedCaseIds: string[];
}
export interface HistoryData {
  caseRetention?: CaseRetention;
  schemaVersion: number;
  runId: string;
  build: string;
  url: string;
  ats: string;
  firstSeen: number;
  lastSeen: number;
  snapshots: HistorySnapshot[];
  events: HistoryEvent[];
  truncated: boolean;
}
export interface HistoryState {
  retentions?: Record<string, CaseRetention>;
  applications: Record<
    string,
    {
      revision: number;
      ack: number;
      pinned?: boolean;
      signature?: string;
      data: HistoryData;
    }
  >;
}
