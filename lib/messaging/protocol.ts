import type { Settings } from '../settings/schema';

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
  /** Provider is up but temporarily overloaded (5xx) — worth retrying. */
  | 'unavailable'
  | 'bad_response';

/** Errors that resolve on their own; the checker backs off instead of giving up. */
export const TRANSIENT_ERROR_CODES: readonly ProviderErrorCode[] = [
  'rate_limit',
  'unavailable',
  'network',
];

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

export type CheckPhase = 'idle' | 'checking' | 'checked' | 'partial' | 'error';

/** Latest checker state for one content-script frame. Sequence prevents a
 * delayed message from overwriting newer state after navigation or typing. */
export interface FrameCheckState {
  phase: CheckPhase;
  count: number;
  sequence: number;
  code?: ProviderErrorCode;
  hint?: string;
}

/** Background-to-content broadcasts never contain provider secrets. */
export type ContentBroadcast = {
  t: 'contentSettingsChanged';
  settings: Settings;
};

export interface ContentSettingsResponse {
  settings: Settings;
  /** Trusted top-level tab hostname, resolved by the background service. */
  siteHost: string | null;
}

// ---------------------------------------------------------------------------
// One-shot messages (chrome.runtime.sendMessage) — control plane
// ---------------------------------------------------------------------------

export type OneShotRequest =
  | { t: 'getTabState' }
  | { t: 'getContentSettings' }
  | { t: 'addPersonalDictionaryWord'; word: string }
  | { t: 'testConnection' }
  | { t: 'listModels' }
  | { t: 'reportFrameState'; state: FrameCheckState };

export interface TabState {
  enabled: boolean;
  host: string | null;
  siteDisabled: boolean;
  issueCount: number;
  checkPhase: CheckPhase;
  checkHint?: string;
}

export type ConnectionResult =
  | { ok: true }
  | { ok: false; code: ProviderErrorCode; hint: string };

export type ModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; code: ProviderErrorCode; hint: string };

export interface OneShotResponseMap {
  getTabState: TabState;
  getContentSettings: ContentSettingsResponse;
  addPersonalDictionaryWord: { ok: true; added: boolean };
  testConnection: ConnectionResult;
  listModels: ModelsResult;
  reportFrameState: { ok: true };
}

// ---------------------------------------------------------------------------
// Port messages (chrome.runtime.connect on CHECK_PORT) — check data plane
// ---------------------------------------------------------------------------

export type PortRequest =
  | { t: 'check'; requestId: string; chunkHash: string; text: string }
  | { t: 'cancel'; requestIds: string[] }
  | { t: 'ping' };

export type PortResponse =
  | {
      t: 'result';
      requestId: string;
      chunkHash: string;
      issues: IssueDto[];
      /** Issues the model reported that could not be located in the text. */
      dropped?: number;
      /** Why they were dropped — field-level detail, never the user's text. */
      droppedReasons?: string[];
      /** Model that produced this result, for UI provenance. Never a key. */
      model?: string;
      /** Deterministic checks succeeded, but contextual model checking did not. */
      incomplete?: { code: ProviderErrorCode; hint: string };
    }
  | { t: 'error'; requestId: string; code: ProviderErrorCode; hint: string };
