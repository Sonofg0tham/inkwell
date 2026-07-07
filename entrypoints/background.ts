import { CheckService } from '../lib/checker/service';
import { CHECK_PORT, type PortRequest } from '../lib/messaging/protocol';
import { createRouter } from '../lib/messaging/typed';
import { getProvider } from '../lib/providers/registry';
import { ProviderError } from '../lib/providers/types';
import { loadSecret, loadSettings } from '../lib/settings/store';

const TAB_COUNTS_KEY = 'tabCounts';

type TabCounts = Record<string, Record<string, number>>;

async function readCounts(): Promise<TabCounts> {
  return ((await chrome.storage.session.get(TAB_COUNTS_KEY))[TAB_COUNTS_KEY] ?? {}) as TabCounts;
}

async function tabTotal(tabId: number): Promise<number> {
  const all = await readCounts();
  const frames = all[String(tabId)] ?? {};
  return Object.values(frames).reduce((a, b) => a + b, 0);
}

/** Per-frame counts (Gmail composes live in iframes) summed into the badge. */
async function setFrameCount(tabId: number, frameId: number, count: number): Promise<void> {
  const all = await readCounts();
  const frames = all[String(tabId)] ?? {};
  if (count > 0) frames[String(frameId)] = count;
  else delete frames[String(frameId)];
  if (Object.keys(frames).length > 0) all[String(tabId)] = frames;
  else delete all[String(tabId)];
  await chrome.storage.session.set({ [TAB_COUNTS_KEY]: all });
  const total = Object.values(frames).reduce((a, b) => a + b, 0);
  try {
    await chrome.action.setBadgeText({ tabId, text: total > 0 ? String(total) : '' });
  } catch {
    // tab already closed
  }
}

export default defineBackground(() => {
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

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== CHECK_PORT) return;
    const requestIds = new Set<string>();
    port.onMessage.addListener((msg: PortRequest) => {
      if (msg.t === 'check') {
        requestIds.add(msg.requestId);
        void service.enqueue(msg.requestId, msg.chunkHash, msg.text, (resp) => {
          requestIds.delete(msg.requestId);
          try {
            port.postMessage(resp);
          } catch {
            // port closed — tab navigated away
          }
        });
      } else if (msg.t === 'cancel') {
        for (const id of msg.requestIds) requestIds.delete(id);
        service.cancel(msg.requestIds);
      }
      // 'ping' needs no handler — receiving it already resets the idle timer.
    });
    port.onDisconnect.addListener(() => {
      service.cancel([...requestIds]);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const all = await readCounts();
      if (all[String(tabId)]) {
        delete all[String(tabId)];
        await chrome.storage.session.set({ [TAB_COUNTS_KEY]: all });
      }
    })();
  });

  createRouter({
    getTabState: async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const settings = await loadSettings();
      let host: string | null = null;
      try {
        host = tab?.url ? new URL(tab.url).hostname || null : null;
      } catch {
        host = null;
      }
      const issueCount = tab?.id != null ? await tabTotal(tab.id) : 0;
      return {
        enabled: settings.enabled,
        host,
        siteDisabled: host !== null && settings.disabledSites.includes(host),
        issueCount,
      };
    },

    testConnection: async () => {
      const settings = await loadSettings();
      const cfg = {
        ...settings.provider,
        apiKey: await loadSecret(settings.provider.kind),
      };
      return getProvider(cfg.kind).testConnection(cfg);
    },

    listModels: async () => {
      try {
        const settings = await loadSettings();
        const cfg = {
          ...settings.provider,
          apiKey: await loadSecret(settings.provider.kind),
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

    reportIssueCount: async (req, sender) => {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        await setFrameCount(tabId, sender.frameId ?? 0, req.count);
      }
      return { ok: true as const };
    },
  });
});
