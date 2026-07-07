// The single source of truth for every message that crosses a context boundary.
// API keys must NEVER appear in any of these payloads — the background service
// worker injects the secret at fetch time (see lib/settings/store.ts).

export const CHECK_PORT = 'inkwell-check';

export type IssueType = 'spelling' | 'grammar' | 'punctuation' | 'style';

export type ProviderErrorCode =
  | 'network'
  | 'auth'
  | 'cors_origin'
  | 'not_found'
  | 'rate_limit'
  | 'bad_response';

/** A located issue, offsets relative to the chunk it was found in. */
export interface IssueDto {
  /** Stable id for dismissal tracking (hash of type+original+occurrence+replacement). */
  id: string;
  type: IssueType;
  start: number;
  end: number;
  original: string;
  replacement: string;
  explanation: string;
}

// ---------------------------------------------------------------------------
// One-shot messages (chrome.runtime.sendMessage) — control plane
// ---------------------------------------------------------------------------

export type OneShotRequest =
  | { t: 'getTabState' }
  | { t: 'testConnection' }
  | { t: 'listModels' }
  | { t: 'reportIssueCount'; count: number };

export interface TabState {
  enabled: boolean;
  host: string | null;
  siteDisabled: boolean;
  issueCount: number;
}

export type ConnectionResult =
  | { ok: true }
  | { ok: false; code: ProviderErrorCode; hint: string };

export type ModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; code: ProviderErrorCode; hint: string };

export interface OneShotResponseMap {
  getTabState: TabState;
  testConnection: ConnectionResult;
  listModels: ModelsResult;
  reportIssueCount: { ok: true };
}

// ---------------------------------------------------------------------------
// Port messages (chrome.runtime.connect on CHECK_PORT) — check data plane
// ---------------------------------------------------------------------------

export type PortRequest =
  | { t: 'check'; requestId: string; chunkHash: string; text: string }
  | { t: 'cancel'; requestIds: string[] }
  | { t: 'ping' };

export type PortResponse =
  | { t: 'result'; requestId: string; chunkHash: string; issues: IssueDto[] }
  | { t: 'error'; requestId: string; code: ProviderErrorCode; hint: string };
