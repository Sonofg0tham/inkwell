import { CheckService, type CheckClient } from '../lib/checker/service';
import {
  CHECK_PORT,
  type CheckPhase,
  type ContentBroadcast,
  type FrameCheckState,
  type PortRequest,
} from '../lib/messaging/protocol';
import { createRouter } from '../lib/messaging/typed';
import { qualifyProofreadingProvider } from '../lib/providers/qualification';
import { getProvider } from '../lib/providers/registry';
import { ProviderError } from '../lib/providers/types';
import {
  CURRENT_DATA_CONSENT_VERSION,
} from '../lib/settings/schema';
import {
  hasProviderOriginPermission,
  missingProviderPermissionHint,
  providerUsesRemoteEndpoint,
  validateProviderEndpoint,
} from '../lib/providers/validation';
import {
  addPersonalDictionaryWord,
  loadSecret,
  loadSettings,
  restrictLocalStorageToTrustedContexts,
  watchSettings,
} from '../lib/settings/store';

const TAB_STATES_KEY = 'tabCheckStates';

type TabStates = Record<string, Record<string, FrameCheckState>>;

async function readStates(): Promise<TabStates> {
  return ((await chrome.storage.session.get(TAB_STATES_KEY))[TAB_STATES_KEY] ?? {}) as TabStates;
}

const PHASE_PRIORITY: Record<CheckPhase, number> = {
  idle: 0,
  checked: 1,
  partial: 2,
  checking: 3,
  error: 4,
};

function aggregateFrames(frames: Record<string, FrameCheckState>): {
  issueCount: number;
  checkPhase: CheckPhase;
  checkHint?: string;
} {
  const states = Object.values(frames);
  const issueCount = states.reduce((total, state) => total + state.count, 0);
  const strongest = states.reduce<FrameCheckState | undefined>((current, state) => {
    if (!current || PHASE_PRIORITY[state.phase] > PHASE_PRIORITY[current.phase]) return state;
    return current;
  }, undefined);
  return {
    issueCount,
    checkPhase: strongest?.phase ?? 'idle',
    ...(strongest?.hint ? { checkHint: strongest.hint } : {}),
  };
}

async function tabSummary(tabId: number): Promise<ReturnType<typeof aggregateFrames>> {
  const all = await readStates();
  return aggregateFrames(all[String(tabId)] ?? {});
}

/** Per-frame states (Gmail composes live in iframes) are sequenced and summed. */
let stateWriteQueue: Promise<void> = Promise.resolve();

async function setFrameState(tabId: number, frameId: number, state: FrameCheckState): Promise<void> {
  const write = stateWriteQueue.then(async () => {
    const all = await readStates();
    const frames = all[String(tabId)] ?? {};
    const previous = frames[String(frameId)];
    if (previous && state.sequence <= previous.sequence) return;
    const safeState: FrameCheckState = {
      phase: state.phase,
      count: Number.isFinite(state.count) ? Math.max(0, Math.min(9_999, Math.trunc(state.count))) : 0,
      sequence: Number.isFinite(state.sequence) ? Math.max(0, Math.trunc(state.sequence)) : 0,
      ...(state.code ? { code: state.code } : {}),
      ...(state.hint ? { hint: state.hint.slice(0, 240) } : {}),
    };
    frames[String(frameId)] = safeState;
    all[String(tabId)] = frames;
    await chrome.storage.session.set({ [TAB_STATES_KEY]: all });
    const total = aggregateFrames(frames).issueCount;
    try {
      await chrome.action.setBadgeText({ tabId, text: total > 0 ? String(total) : '' });
    } catch {
      // tab already closed
    }
  });
  stateWriteQueue = write.catch(() => undefined);
  await write;
}

async function clearFrameState(tabId: number, frameId: number): Promise<void> {
  const write = stateWriteQueue.then(async () => {
    const all = await readStates();
    const frames = all[String(tabId)];
    if (!frames?.[String(frameId)]) return;
    delete frames[String(frameId)];
    if (Object.keys(frames).length === 0) delete all[String(tabId)];
    await chrome.storage.session.set({ [TAB_STATES_KEY]: all });
    const total = aggregateFrames(frames).issueCount;
    try {
      await chrome.action.setBadgeText({ tabId, text: total > 0 ? String(total) : '' });
    } catch {
      // tab already closed
    }
  });
  stateWriteQueue = write.catch(() => undefined);
  await write;
}

function senderOrigin(sender: chrome.runtime.MessageSender | undefined): string | undefined {
  if (sender?.origin && sender.origin !== 'null') return sender.origin;
  for (const candidate of [sender?.url, sender?.tab?.url]) {
    if (!candidate) continue;
    try {
      const origin = new URL(candidate).origin;
      if (origin !== 'null') return origin;
    } catch {
      // about:, data: and browser-internal senders may not have an origin.
    }
  }
  return undefined;
}

interface ProviderAccessContext {
  /** Port callers must prove which page is asking to process its text. */
  enforceSiteBoundary?: boolean;
  clientOrigin?: string;
}

async function loadAuthorisedProvider(context: ProviderAccessContext = {}) {
  const settings = await loadSettings();
  if (settings.dataConsentVersion < CURRENT_DATA_CONSENT_VERSION) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        code: 'bad_response' as const,
        hint: 'Open Inkwell Settings and accept the privacy disclosure before checking any writing.',
      },
    };
  }

  if (context.enforceSiteBoundary) {
    let origin: URL;
    try {
      if (!context.clientOrigin) throw new Error('Missing origin');
      origin = new URL(context.clientOrigin);
    } catch {
      return {
        ok: false as const,
        result: {
          ok: false as const,
          code: 'cors_origin' as const,
          hint: 'Inkwell could not verify which page requested this check, so no text was processed.',
        },
      };
    }

    if (origin.protocol === 'http:' || origin.protocol === 'https:') {
      const host = origin.hostname.toLowerCase();
      if (settings.disabledSites.includes(host)) {
        return {
          ok: false as const,
          result: {
            ok: false as const,
            code: 'cors_origin' as const,
            hint: `Inkwell is disabled on ${host}. Enable the site before checking its text.`,
          },
        };
      }
      if (
        providerUsesRemoteEndpoint(settings.provider.kind, settings.provider.baseUrl) &&
        !settings.cloudAllowedSites.includes(host)
      ) {
        return {
          ok: false as const,
          result: {
            ok: false as const,
            code: 'cors_origin' as const,
            hint: `Cloud checking is off for ${host}. Enable this site from the Inkwell popup first.`,
          },
        };
      }
    } else if (
      origin.protocol !== 'chrome-extension:' ||
      origin.hostname !== chrome.runtime.id
    ) {
      return {
        ok: false as const,
        result: {
          ok: false as const,
          code: 'cors_origin' as const,
          hint: 'This page is not allowed to ask Inkwell to process text.',
        },
      };
    }
  }

  let endpoint;
  try {
    endpoint = validateProviderEndpoint(settings.provider.kind, settings.provider.baseUrl);
  } catch (err) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        code: 'bad_response' as const,
        hint: err instanceof Error ? err.message : 'The model server address is invalid.',
      },
    };
  }

  if (!(await hasProviderOriginPermission(endpoint))) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        code: 'cors_origin' as const,
        hint: missingProviderPermissionHint(endpoint),
      },
    };
  }

  return { ok: true as const, settings, endpoint };
}

export default defineBackground(() => {
  // chrome.storage.local is otherwise exposed to content-script contexts.
  // Begin the restriction before registering any data-plane work, then gate
  // checks on this promise so a freshly started worker has no timing window.
  const storageBoundaryReady = restrictLocalStorageToTrustedContexts();
  void storageBoundaryReady.catch((err: unknown) => {
    console.error(
      '[Inkwell] Could not restrict extension storage to trusted contexts.',
      err instanceof Error ? err.message : String(err),
    );
  });

  chrome.runtime.onInstalled?.addListener((details) => {
    if (details.reason === 'install') void chrome.runtime.openOptionsPage();
  });

  // MV3 keep-alive while checks are in flight: extension API calls reset the
  // service worker's 30 s idle timer (documented Chrome pattern).
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const service = new CheckService((busy) => {
    if (busy && keepalive === undefined) {
      keepalive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
    } else if (!busy && keepalive !== undefined) {
      clearInterval(keepalive);
      keepalive = undefined;
    }
  });

  void chrome.action.setBadgeBackgroundColor({ color: '#e86a3d' });
  try {
    void chrome.action.setBadgeTextColor({ color: '#fffdf8' });
  } catch {
    // not supported on very old Chromium
  }

  let clientSequence = 0;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== CHECK_PORT) return;
    const client: CheckClient = {
      id: `${port.sender?.tab?.id ?? 'extension'}:${port.sender?.frameId ?? 0}:${++clientSequence}`,
      origin: senderOrigin(port.sender),
    };
    if (port.sender?.tab?.id != null) {
      void clearFrameState(port.sender.tab.id, port.sender.frameId ?? 0);
    }
    const requestIds = new Set<string>();
    port.onMessage.addListener((msg: PortRequest) => {
      if (msg.t === 'check') {
        requestIds.add(msg.requestId);
        void storageBoundaryReady.then(async () => {
          // A cancel or disconnect may have arrived while storage was locking.
          if (!requestIds.has(msg.requestId)) return;
          const access = await loadAuthorisedProvider({
            enforceSiteBoundary: true,
            clientOrigin: client.origin,
          });
          // Permission checks are asynchronous, so cancellation must be checked again.
          if (!requestIds.has(msg.requestId)) return;
          if (!access.ok) {
            requestIds.delete(msg.requestId);
            try {
              port.postMessage({
                t: 'error',
                requestId: msg.requestId,
                code: access.result.code,
                hint: access.result.hint,
              });
            } catch {
              // port closed
            }
            return;
          }
          service.enqueue(client, msg.requestId, msg.chunkHash, msg.text, (resp) => {
            requestIds.delete(msg.requestId);
            try {
              port.postMessage(resp);
            } catch {
              // port closed — tab navigated away
            }
          });
        }).catch(() => {
          requestIds.delete(msg.requestId);
          try {
            port.postMessage({
              t: 'error',
              requestId: msg.requestId,
              code: 'bad_response',
              hint: 'Inkwell could not establish its secure storage boundary. Reload the extension.',
            });
          } catch {
            // port closed
          }
        });
      } else if (msg.t === 'cancel') {
        for (const id of msg.requestIds) requestIds.delete(id);
        service.cancel(client.id, msg.requestIds);
      }
      // 'ping' needs no handler — receiving it already resets the idle timer.
    });
    port.onDisconnect.addListener(() => {
      requestIds.clear();
      service.cancelClient(client.id);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const all = await readStates();
      if (all[String(tabId)]) {
        delete all[String(tabId)];
        await chrome.storage.session.set({ [TAB_STATES_KEY]: all });
      }
    })();
  });

  const storageEvents = (chrome.storage as Partial<typeof chrome.storage>).onChanged;
  if (storageEvents) {
    watchSettings((settings) => {
      void chrome.tabs.query({}).then((tabs) => {
        const message: ContentBroadcast = { t: 'contentSettingsChanged', settings };
        for (const tab of tabs) {
          if (tab.id == null || typeof chrome.tabs.sendMessage !== 'function') continue;
          void chrome.tabs.sendMessage(tab.id, message).catch(() => {
            // Restricted pages and tabs without a content script are expected.
          });
        }
      });
    });
  }

  createRouter({
    getTabState: async () => {
      await storageBoundaryReady;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const settings = await loadSettings();
      let host: string | null = null;
      try {
        host = tab?.url ? new URL(tab.url).hostname || null : null;
      } catch {
        host = null;
      }
      const summary = tab?.id != null
        ? await tabSummary(tab.id)
        : { issueCount: 0, checkPhase: 'idle' as const };
      return {
        enabled: settings.enabled,
        host,
        siteDisabled:
          host !== null &&
          (settings.disabledSites.includes(host) ||
            (providerUsesRemoteEndpoint(settings.provider.kind, settings.provider.baseUrl) &&
              !settings.cloudAllowedSites.includes(host))),
        ...summary,
      };
    },

    getContentSettings: async () => {
      await storageBoundaryReady;
      return loadSettings();
    },

    addPersonalDictionaryWord: async (req) => {
      await storageBoundaryReady;
      const added = await addPersonalDictionaryWord(req.word);
      return { ok: true as const, added };
    },

    testConnection: async () => {
      await storageBoundaryReady;
      const access = await loadAuthorisedProvider();
      if (!access.ok) return access.result;
      const cfg = {
        ...access.settings.provider,
        baseUrl: access.endpoint.baseUrl,
        apiKey: await loadSecret(access.settings.provider.kind),
      };
      return qualifyProofreadingProvider(
        getProvider(cfg.kind),
        cfg,
        access.settings,
      );
    },

    listModels: async () => {
      try {
        await storageBoundaryReady;
        const access = await loadAuthorisedProvider();
        if (!access.ok) return access.result;
        const cfg = {
          ...access.settings.provider,
          baseUrl: access.endpoint.baseUrl,
          apiKey: await loadSecret(access.settings.provider.kind),
        };
        const models = await getProvider(cfg.kind).listModels(cfg);
        return { ok: true as const, models };
      } catch (err) {
        return {
          ok: false as const,
          code: err instanceof ProviderError ? err.code : ('network' as const),
          hint: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    },

    reportFrameState: async (req, sender) => {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        await setFrameState(tabId, sender.frameId ?? 0, req.state);
      }
      return { ok: true as const };
    },
  });
});
