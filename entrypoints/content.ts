import { startWatcher } from '../lib/content/editableWatcher';
import { PortClient } from '../lib/content/portClient';
import type { FieldEnv } from '../lib/content/fieldController';
import { sendTyped } from '../lib/messaging/typed';
import { DEFAULT_SETTINGS, type Settings } from '../lib/settings/schema';
import { loadSettings, watchSettings } from '../lib/settings/store';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    let settings: Settings = DEFAULT_SETTINGS;
    let stop: (() => void) | null = null;
    const port = new PortClient();

    const env: FieldEnv = {
      getSettings: () => settings,
      port,
      reportCount: (count) => {
        void sendTyped({ t: 'reportIssueCount', count }).catch(() => {
          // background asleep or extension reloading — badge catches up later
        });
      },
    };

    const evaluate = (): void => {
      const host = location.hostname;
      const on = settings.enabled && !settings.disabledSites.includes(host);
      if (on && !stop) {
        stop = startWatcher(env);
      } else if (!on && stop) {
        stop();
        stop = null;
        env.reportCount(0);
      }
    };

    void loadSettings().then((s) => {
      settings = s;
      evaluate();
    });
    watchSettings((s) => {
      settings = s;
      evaluate();
    });
  },
});
