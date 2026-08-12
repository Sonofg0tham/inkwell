import '../../brand-theme.css';
import './style.css';
import { blottySvg, type BlottyMood } from '../../lib/ui/blotty';
import { sendTyped } from '../../lib/messaging/typed';
import { providerUsesRemoteEndpoint } from '../../lib/providers/validation';
import {
  CURRENT_DATA_CONSENT_VERSION,
  PROVIDER_LABELS,
  type Settings,
} from '../../lib/settings/schema';
import { canonicaliseSiteHost } from '../../lib/settings/sites';
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
const openWorkspace = document.getElementById('open-workspace') as HTMLButtonElement;
const openSettings = document.getElementById('open-settings') as HTMLButtonElement;
const quickStrictness = document.getElementById('quick-strictness') as HTMLSelectElement;
const quickDialect = document.getElementById('quick-dialect') as HTMLSelectElement;
const quickCategories = document.querySelectorAll<HTMLInputElement>('[data-category]');

let currentHost: string | null = null;
let lastTestFailed = false;
let currentSettings: Settings | null = null;

function setMood(mood: BlottyMood): void {
  blottyEl.innerHTML = blottySvg(mood, 44); // static SVG, no user data
}

function refreshMood(enabled: boolean): void {
  setMood(!enabled ? 'asleep' : lastTestFailed ? 'dizzy' : 'happy');
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  currentSettings = settings;
  const consented = settings.dataConsentVersion >= CURRENT_DATA_CONSENT_VERSION;
  toggleGlobal.checked = settings.enabled && consented;
  quickStrictness.value = settings.strictness;
  quickDialect.value = settings.dialect;
  quickCategories.forEach((input) => {
    input.checked = settings.categories[input.dataset.category as keyof typeof settings.categories];
  });
  providerLine.textContent = `${PROVIDER_LABELS[settings.provider.kind]} · ${settings.provider.model}`;
  refreshMood(settings.enabled);

  const state = await sendTyped({ t: 'getTabState' }).catch(() => null);
  const activeHost = canonicaliseSiteHost(state?.host ?? '');
  if (state && activeHost) {
    currentHost = activeHost;
    siteHost.textContent = activeHost;
    toggleSite.checked = !state.siteDisabled;
    siteRow.hidden = false;
  }
  if (!consented) {
    issueLine.textContent = 'Finish the privacy setup before Inkwell checks any writing.';
    issueLine.hidden = false;
  } else if (state && settings.enabled) {
    if (state.checkPhase === 'error') {
      issueLine.textContent = 'Checker unavailable on this page. Open settings to reconnect.';
    } else if (state.checkPhase === 'checking') {
      issueLine.textContent = 'Checking this page…';
    } else if (state.checkPhase === 'partial') {
      issueLine.textContent = state.issueCount > 0
        ? `${state.issueCount} suggestion${state.issueCount === 1 ? '' : 's'}, but part of the check could not be verified`
        : 'Check incomplete. Some writing could not be verified.';
    } else if (state.checkPhase === 'checked') {
      issueLine.textContent = state.issueCount > 0
        ? `${state.issueCount} suggestion${state.issueCount === 1 ? '' : 's'} on this page`
        : 'No suggestions on this page right now';
    } else {
      issueLine.textContent = 'Start typing to check this page.';
    }
    issueLine.hidden = false;
  }
}

async function updateQuickSettings(mutator: (settings: Settings) => void): Promise<void> {
  const settings = currentSettings ?? await loadSettings();
  mutator(settings);
  currentSettings = settings;
  await saveSettings(settings);
}

toggleGlobal.addEventListener('change', () => {
  void (async () => {
    const settings = await loadSettings();
    if (toggleGlobal.checked && settings.dataConsentVersion < CURRENT_DATA_CONSENT_VERSION) {
      toggleGlobal.checked = false;
      await chrome.runtime.openOptionsPage();
      return;
    }
    settings.enabled = toggleGlobal.checked;
    await saveSettings(settings);
    currentSettings = settings;
    refreshMood(settings.enabled);
  })();
});

toggleSite.addEventListener('change', () => {
  void (async () => {
    if (!currentHost) return;
    const settings = await loadSettings();
    const host = canonicaliseSiteHost(currentHost);
    const disabled = new Set(
      settings.disabledSites.map(canonicaliseSiteHost).filter(Boolean),
    );
    const cloudAllowed = new Set(
      settings.cloudAllowedSites.map(canonicaliseSiteHost).filter(Boolean),
    );
    const usesCloud = providerUsesRemoteEndpoint(
      settings.provider.kind,
      settings.provider.baseUrl,
    );
    if (toggleSite.checked) {
      disabled.delete(host);
      if (usesCloud) cloudAllowed.add(host);
    } else if (usesCloud) {
      cloudAllowed.delete(host);
    } else {
      disabled.add(host);
    }
    settings.disabledSites = [...disabled];
    settings.cloudAllowedSites = [...cloudAllowed];
    await saveSettings(settings);
    currentSettings = settings;
  })();
});

quickCategories.forEach((input) => {
  input.addEventListener('change', () => {
    void (async () => {
      await updateQuickSettings((settings) => {
        const category = input.dataset.category as keyof typeof settings.categories;
        settings.categories[category] = input.checked;
      });
    })();
  });
});

quickStrictness.addEventListener('change', () => {
  void (async () => {
    await updateQuickSettings((settings) => {
      settings.strictness = quickStrictness.value as typeof settings.strictness;
    });
  })();
});

quickDialect.addEventListener('change', () => {
  void (async () => {
    await updateQuickSettings((settings) => {
      settings.dialect = quickDialect.value as typeof settings.dialect;
    });
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

openWorkspace.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

void init();
