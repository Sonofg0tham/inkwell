import '../../brand-theme.css';
import './style.css';
import { blottySvg } from '../../lib/ui/blotty';
import { sendTyped } from '../../lib/messaging/typed';
import {
  CLOUD_KINDS,
  DEFAULT_BASE_URLS,
  normalizeBaseUrl,
  PROVIDER_KINDS,
  type ProviderKind,
  type Settings,
} from '../../lib/settings/schema';
import { hasSecret, loadSettings, saveSecret, saveSettings } from '../../lib/settings/store';

const blottyEl = document.getElementById('blotty')!;
const form = document.getElementById('settings-form') as HTMLFormElement;
const providerSelect = document.getElementById('provider') as HTMLSelectElement;
const cloudNotice = document.getElementById('cloud-notice')!;
const baseUrlInput = document.getElementById('base-url') as HTMLInputElement;
const baseUrlHint = document.getElementById('base-url-hint')!;
const apiKeyField = document.getElementById('api-key-field')!;
const apiKeyInput = document.getElementById('api-key') as HTMLInputElement;
const removeKeyBtn = document.getElementById('remove-key') as HTMLButtonElement;
const modelInput = document.getElementById('model') as HTMLInputElement;
const modelList = document.getElementById('model-list') as HTMLDataListElement;
const fetchModelsBtn = document.getElementById('fetch-models') as HTMLButtonElement;
const modelsHint = document.getElementById('models-hint')!;
const formalitySelect = document.getElementById('formality') as HTMLSelectElement;
const strictnessSelect = document.getElementById('strictness') as HTMLSelectElement;
const blocklistArea = document.getElementById('blocklist') as HTMLTextAreaElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const saveResult = document.getElementById('save-result')!;

const categoryBoxes = {
  spelling: document.getElementById('cat-spelling') as HTMLInputElement,
  grammar: document.getElementById('cat-grammar') as HTMLInputElement,
  punctuation: document.getElementById('cat-punctuation') as HTMLInputElement,
  style: document.getElementById('cat-style') as HTMLInputElement,
};

blottyEl.innerHTML = blottySvg('happy', 56); // static SVG, no user data

let current: Settings;

function selectedKind(): ProviderKind {
  const v = providerSelect.value as ProviderKind;
  return PROVIDER_KINDS.includes(v) ? v : 'ollama';
}

function selectedDialect(): Settings['dialect'] {
  const checked = form.querySelector<HTMLInputElement>('input[name="dialect"]:checked');
  return checked?.value === 'en-US' ? 'en-US' : 'en-GB';
}

function showResult(tone: 'ok' | 'error' | 'busy', message: string): void {
  saveResult.textContent = message;
  saveResult.setAttribute('data-tone', tone);
  saveResult.hidden = false;
}

async function refreshKeyUi(): Promise<void> {
  const kind = selectedKind();
  apiKeyField.hidden = kind === 'ollama';
  cloudNotice.hidden = !CLOUD_KINDS.includes(kind);
  const saved = await hasSecret(kind);
  apiKeyInput.placeholder = saved ? 'Saved — leave blank to keep it' : 'Paste your key';
  removeKeyBtn.hidden = !saved;
}

function onProviderChange(previousKind: ProviderKind): void {
  const kind = selectedKind();
  const value = normalizeBaseUrl(baseUrlInput.value);
  if (value === '' || value === DEFAULT_BASE_URLS[previousKind]) {
    baseUrlInput.value = DEFAULT_BASE_URLS[kind];
  }
  baseUrlHint.textContent =
    kind === 'ollama'
      ? 'Default Ollama address. Ollama must be started with OLLAMA_ORIGINS=chrome-extension://* (or *).'
      : kind === 'openai-compat'
        ? 'Default LM Studio address. Works with any OpenAI-compatible server — enable CORS in LM Studio.'
        : 'Official API address — you normally won’t change this.';
  modelList.replaceChildren();
  modelsHint.hidden = true;
  void refreshKeyUi();
}

/** Origins covered by the static host_permissions in the manifest. */
function isStaticallyAllowed(origin: string): boolean {
  const url = new URL(origin);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  return origin === 'https://api.openai.com' || origin === 'https://api.anthropic.com';
}

/**
 * Validates and saves the form. Returns true on success. Kept synchronous up
 * to the optional permission request — chrome.permissions.request must run
 * inside the user-gesture context.
 */
async function persist(): Promise<boolean> {
  const kind = selectedKind();
  let baseUrl: string;
  let origin: string;
  try {
    baseUrl = normalizeBaseUrl(baseUrlInput.value) || DEFAULT_BASE_URLS[kind];
    origin = new URL(baseUrl).origin;
  } catch {
    showResult('error', 'That server address doesn’t look like a valid URL.');
    return false;
  }

  if (!isStaticallyAllowed(origin)) {
    // Runtime grant for custom origins only — never a blanket permission.
    const granted = await chrome.permissions
      .request({ origins: [`${origin}/*`] })
      .catch(() => false);
    if (!granted) {
      showResult(
        'error',
        `Permission for ${origin} was declined, so Inkwell can’t reach it. Nothing was saved.`,
      );
      return false;
    }
  }

  const settings: Settings = {
    ...current,
    provider: {
      kind,
      baseUrl,
      model: modelInput.value.trim() || current.provider.model,
    },
    dialect: selectedDialect(),
    formality: formalitySelect.value as Settings['formality'],
    strictness: strictnessSelect.value as Settings['strictness'],
    categories: {
      spelling: categoryBoxes.spelling.checked,
      grammar: categoryBoxes.grammar.checked,
      punctuation: categoryBoxes.punctuation.checked,
      style: categoryBoxes.style.checked,
    },
    disabledSites: blocklistArea.value
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0),
  };

  await saveSettings(settings);
  current = settings;

  const key = apiKeyInput.value.trim();
  if (key) {
    await saveSecret(kind, key);
    apiKeyInput.value = '';
  }
  await refreshKeyUi();
  return true;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  void (async () => {
    saveBtn.disabled = true;
    const saved = await persist();
    if (saved) {
      showResult('busy', 'Saved. Testing the connection…');
      const result = await sendTyped({ t: 'testConnection' }).catch(() => ({
        ok: false as const,
        code: 'network' as const,
        hint: 'Could not reach the background service.',
      }));
      if (result.ok) showResult('ok', 'Saved and connected. You’re all set.');
      else showResult('error', `Saved, but the connection test failed: ${result.hint}`);
    }
    saveBtn.disabled = false;
  })();
});

fetchModelsBtn.addEventListener('click', () => {
  void (async () => {
    fetchModelsBtn.disabled = true;
    modelsHint.textContent = 'Fetching…';
    modelsHint.hidden = false;
    const saved = await persist();
    if (!saved) {
      fetchModelsBtn.disabled = false;
      modelsHint.hidden = true;
      return;
    }
    const result = await sendTyped({ t: 'listModels' }).catch(() => ({
      ok: false as const,
      code: 'network' as const,
      hint: 'Could not reach the background service.',
    }));
    fetchModelsBtn.disabled = false;
    if (!result.ok) {
      modelsHint.textContent = result.hint;
      return;
    }
    modelList.replaceChildren(
      ...result.models.map((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        return opt;
      }),
    );
    modelsHint.textContent =
      result.models.length > 0
        ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} available — start typing in the model box to pick one.`
        : 'The server responded but listed no models.';
  })();
});

removeKeyBtn.addEventListener('click', () => {
  void (async () => {
    await saveSecret(selectedKind(), null);
    await refreshKeyUi();
    showResult('ok', 'API key removed from this device.');
  })();
});

providerSelect.addEventListener('change', () => {
  onProviderChange(current.provider.kind);
  // remember the visible kind so switching back and forth behaves
  current = { ...current, provider: { ...current.provider, kind: selectedKind() } };
});

async function init(): Promise<void> {
  current = await loadSettings();
  providerSelect.value = current.provider.kind;
  baseUrlInput.value = current.provider.baseUrl;
  modelInput.value = current.provider.model;
  const dialectRadio = form.querySelector<HTMLInputElement>(
    `input[name="dialect"][value="${current.dialect}"]`,
  );
  if (dialectRadio) dialectRadio.checked = true;
  formalitySelect.value = current.formality;
  strictnessSelect.value = current.strictness;
  categoryBoxes.spelling.checked = current.categories.spelling;
  categoryBoxes.grammar.checked = current.categories.grammar;
  categoryBoxes.punctuation.checked = current.categories.punctuation;
  categoryBoxes.style.checked = current.categories.style;
  blocklistArea.value = current.disabledSites.join('\n');
  onProviderChange(current.provider.kind);
  baseUrlInput.value = current.provider.baseUrl; // onProviderChange may have reset it
}

void init();
