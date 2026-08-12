import { startWatcher, type WatcherHandle } from '../lib/content/editableWatcher';
import { PortClient } from '../lib/content/portClient';
import type { FieldEnv } from '../lib/content/fieldController';
import type { ContentBroadcast, FrameCheckState } from '../lib/messaging/protocol';
import { sendTyped } from '../lib/messaging/typed';
import { providerUsesRemoteEndpoint } from '../lib/providers/validation';
import {
  CURRENT_DATA_CONSENT_VERSION,
  DEFAULT_SETTINGS,
  type Settings,
} from '../lib/settings/schema';
import { siteHostListIncludes } from '../lib/settings/sites';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  runAt: 'document_idle',
  main() {
    let settings: Settings = DEFAULT_SETTINGS;
    let siteHost: string | null = null;
    let watcher: WatcherHandle | null = null;
    let stateSequence = 0;
    const port = new PortClient();

    const reportState = (state: Omit<FrameCheckState, 'sequence'>): void => {
      void sendTyped({
        t: 'reportFrameState',
        state: { ...state, sequence: ++stateSequence },
      }).catch(() => {
        // The service worker may be restarting. The next state supersedes this.
      });
    };

    const env: FieldEnv = {
      getSettings: () => settings,
      port,
      // Phase-aware reports below carry the count as well. Keep this narrow
      // hook for controller tests and older callers without duplicating IPC.
      reportCount: () => undefined,
      reportStatus: reportState,
      addToDictionary: (word) => {
        void sendTyped({ t: 'addPersonalDictionaryWord', word }).catch(() => {
          console.warn('[Inkwell] Could not save the personal dictionary word.');
        });
      },
    };

    const evaluate = (): void => {
      const host = siteHost;
      const usesCloud = providerUsesRemoteEndpoint(
        settings.provider.kind,
        settings.provider.baseUrl,
      );
      const on =
        settings.enabled &&
        settings.dataConsentVersion >= CURRENT_DATA_CONSENT_VERSION &&
        host !== null &&
        !siteHostListIncludes(settings.disabledSites, host) &&
        (!usesCloud || siteHostListIncludes(settings.cloudAllowedSites, host));
      if (on && !watcher) {
        watcher = startWatcher(env);
      } else if (!on && watcher) {
        watcher.stop();
        watcher = null;
        reportState({ phase: 'idle', count: 0 });
      }
    };

    chrome.runtime.onMessage.addListener((message: ContentBroadcast) => {
      if (message?.t !== 'contentSettingsChanged') return;
      settings = message.settings;
      watcher?.settingsChanged();
      evaluate();
    });

    void sendTyped({ t: 'getContentSettings' })
      .then((response) => {
        settings = response.settings;
        siteHost = response.siteHost;
        evaluate();
      })
      .catch(() => {
        // Fail closed if the trusted settings boundary is unavailable. Running
        // with defaults could silently enable checking on a disabled site.
        reportState({
          phase: 'error',
          count: 0,
          code: 'network',
          hint: 'Inkwell could not load its settings. Reload the page and try again.',
        });
      });
  },
});
