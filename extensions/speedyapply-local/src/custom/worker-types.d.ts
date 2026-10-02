/** Shapes owned by the extension worker and persisted in its private storage. */
export interface BrowserTarget {
  tabId: number;
  frameId: number;
  documentId: string;
}
export interface BrowserField {
  id: string;
  question: string;
  type: string;
  required: boolean;
  filled: boolean;
  invalid: boolean;
  supported: boolean;
  value?: string | boolean | string[];
  options?: { value: string; label: string }[];
}
export interface BrowserEvent {
  at: number;
  type: string;
  detail?: string;
  fieldId?: string;
}
export interface BrowserPage extends BrowserTarget {
  revision: number;
  url: string;
  title: string;
  profileId: string | null;
  profileName: string;
  ats: string;
  phase: string;
  visibility: string;
  coverage: string;
  observedAt: number;
  fields: BrowserField[];
  events?: BrowserEvent[];
  actions: string[];
  counts: { total: number; unfilled: number; unsupported: number };
  review?: {
    id: string;
    ready: boolean;
    items: {
      itemId: string;
      fieldId: string;
      version: number;
      state?: string;
    }[];
  };
}
export interface BrowserFrame extends BrowserTarget {
  browserDocumentId?: string;
  lifecycleId?: string;
  snapshot?: BrowserPage;
}
export interface CommandResult {
  id: string;
  state: "completed" | "failed" | "unknown";
  error?: string;
  data?: unknown;
}
export interface BrowserCommand {
  id: string;
  sessionId: string;
  expiresAt: number;
  target: BrowserTarget & { revision: number };
  action: string;
  args?: unknown;
}
export interface BrowserControlState {
  sessionId: string;
  frames: Record<string, BrowserFrame>;
  journal: Record<
    string,
    {
      key: string;
      result: CommandResult;
      expiresAt?: number;
      reported?: boolean;
    }
  >;
  results: CommandResult[];
  snapshotRequests?: BrowserTarget[];
  lastExchangeAt?: number;
  error?: string;
}
export interface PrivateConnectionState {
  profileToken?: string;
  disabled?: boolean;
}
/** The archive transports field details opaquely; the diagnostics page reads them. */
export interface DiagnosticReport {
  schemaVersion: number;
  sessionId: string;
  runId?: string;
  valuePolicy: string;
  verdict: string;
  pageUrl: string;
  ats?: string;
  profileName?: string;
  phase?: string;
  observedAt: number;
  counts?: {
    controls: number;
    empty: number;
    invalid: number;
    unattempted: number;
  };
  fields: unknown[];
  events: BrowserEvent[];
}
export interface DiagnosticArchiveState {
  reports: Record<
    string,
    {
      id: string;
      tabId: number;
      frameId: number;
      documentId?: string;
      receivedAt: number;
      revision: number;
      report: DiagnosticReport;
    }
  >;
}
/** Validated synthetic structure is stored intact and never interpreted by this worker. */
export interface ReproductionCase {
  schemaVersion: number;
  origin: string;
  ats: string;
  build: string;
  fields: unknown[];
  timeline: {
    ms: number;
    type: string;
    field?: string;
    decision?: Record<string, string>;
    state?: Record<string, Record<string, boolean | number>>;
  }[];
}
export interface ReproductionArchiveState {
  applications: Record<
    string,
    {
      at?: number;
      fingerprint?: string;
      url?: string;
      cases: {
        id: string;
        at: number;
        value: ReproductionCase;
        runId?: string;
        resolvedAt?: number;
      }[];
    }
  >;
}
