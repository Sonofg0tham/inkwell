import '../../brand-theme.css';
import './style.css';
import { blottySvg, type BlottyMood } from '../../lib/ui/blotty';
import { sendTyped } from '../../lib/messaging/typed';
import { PROVIDER_LABELS } from '../../lib/settings/schema';
import { loadSettings, saveSettings } from '../../lib/settings/store';

const blottyEl = document.getElementById('blotty')!;
const toggleGlobal = document.getElementById('toggle-global') as HTMLInputElement;
const siteRow = document.getElementById('site-row') as HTMLLabelElement;
const siteHost = document.getElementById('site-host')!;
const toggleSite = document.getElementById('toggle-site') as HTMLInputElement;
const statusDot = document.getElementById('status-dot')!;
const providerLine = document.getElementById('provider-line')!;
const testBtn = document.getElementById('test-btn') as HTMLButtonElement;
const statusHint = document.getElementById('status-hint')!;
const issueLine = document.getElementById('issue-line')!;
const openSettings = document.getElementById('open-settings') as HTMLButtonElement;

let currentHost: string | null = null;
let lastTestFailed = false;

function setMood(mood: BlottyMood): void {
  blottyEl.innerHTML = blottySvg(mood, 44); // static SVG, no user data
}

function refreshMood(enabled: boolean): void {
  setMood(!enabled ? 'asleep' : lastTestFailed ? 'dizzy' : 'happy');
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  toggleGlobal.checked = settings.enabled;
  providerLine.textContent = `${PROVIDER_LABELS[settings.provider.kind]} · ${settings.provider.model}`;
  refreshMood(settings.enabled);

  const state = await sendTyped({ t: 'getTabState' }).catch(() => null);
  if (state?.host) {
    currentHost = state.host;
    siteHost.textContent = state.host;
    toggleSite.checked = !state.siteDisabled;
    siteRow.hidden = false;
  }
  if (state && settings.enabled) {
    issueLine.textContent =
      state.issueCount > 0
        ? `${state.issueCount} suggestion${state.issueCount === 1 ? '' : 's'} on this page`
        : 'No suggestions on this page right now';
    issueLine.hidden = false;
  }
}

toggleGlobal.addEventListener('change', () => {
  void (async () => {
    const settings = await loadSettings();
    settings.enabled = toggleGlobal.checked;
    await saveSettings(settings);
    refreshMood(settings.enabled);
  })();
});

toggleSite.addEventListener('change', () => {
  void (async () => {
    if (!currentHost) return;
    const settings = await loadSettings();
    const set = new Set(settings.disabledSites);
    if (toggleSite.checked) set.delete(currentHost);
    else set.add(currentHost);
    settings.disabledSites = [...set];
    await saveSettings(settings);
  })();
});

testBtn.addEventListener('click', () => {
  void (async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    statusDot.dataset.state = 'busy';
    statusHint.hidden = true;
    const result = await sendTyped({ t: 'testConnection' }).catch(() => ({
      ok: false as const,
      code: 'network' as const,
      hint: 'Could not reach the background service. Try reopening the popup.',
    }));
    testBtn.disabled = false;
    testBtn.textContent = 'Test';
    lastTestFailed = !result.ok;
    statusDot.dataset.state = result.ok ? 'ok' : 'error';
    if (result.ok) {
      statusHint.textContent = 'Connected and ready.';
      statusHint.setAttribute('data-ok', 'true');
    } else {
      statusHint.textContent = result.hint;
      statusHint.removeAttribute('data-ok');
    }
    statusHint.hidden = false;
    refreshMood(toggleGlobal.checked);
  })();
});

openSettings.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});

void init();
