import '../../brand-theme.css';
import './style.css';
import { blottySvg } from '../../lib/ui/blotty';
import { sendTyped } from '../../lib/messaging/typed';
import {
  CLOUD_KINDS,
  CURRENT_DATA_CONSENT_VERSION,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  DIALECTS,
  KEY_HELP_URLS,
  PROVIDER_KINDS,
  PROVIDER_LABELS,
  type ProviderKind,
  type Settings,
} from '../../lib/settings/schema';
import { parseSiteHostList } from '../../lib/settings/sites';
import {
  addPersonalDictionaryWord,
  clearPersonalDictionary,
  hasSecret,
  loadSettings,
  removePersonalDictionaryWord,
  saveSecret,
  saveSettings,
} from '../../lib/settings/store';
import {
  ProviderEndpointError,
  requestProviderOriginPermission,
  validateProviderEndpoint,
} from '../../lib/providers/validation';

const blottyEl = document.getElementById('blotty')!;
const form = document.getElementById('settings-form') as HTMLFormElement;
const consentPanel = document.getElementById('privacy-consent')!;
const consentTitle = document.getElementById('privacy-consent-title')!;
const consentCheckbox = document.getElementById('data-consent') as HTMLInputElement;
const consentState = document.getElementById('consent-state')!;
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
const dictionaryInput = document.getElementById('dictionary-word') as HTMLInputElement;
const dictionaryAdd = document.getElementById('dictionary-add') as HTMLButtonElement;
const dictionaryClear = document.getElementById('dictionary-clear') as HTMLButtonElement;
const dictionaryList = document.getElementById('dictionary-list') as HTMLUListElement;
const dictionaryEmpty = document.getElementById('dictionary-empty')!;
const dictionaryStatus = document.getElementById('dictionary-status')!;
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

function updateConsentUi(accepted: boolean): void {
  consentPanel.setAttribute('data-state', accepted ? 'accepted' : 'pending');
  consentCheckbox.checked = accepted;
  consentCheckbox.disabled = accepted;
  consentState.textContent = accepted
    ? 'Privacy choice saved. Inkwell can now check writing when you enable it.'
    : 'Required before Inkwell can check text or open stored documents.';
}

function extensionOrigin(): string {
  return chrome.runtime.getURL('').replace(/\/$/, '');
}

function selectedKind(): ProviderKind {
  const v = providerSelect.value as ProviderKind;
  return PROVIDER_KINDS.includes(v) ? v : 'ollama';
}

function selectedDialect(): Settings['dialect'] {
  const checked = form.querySelector<HTMLInputElement>('input[name="dialect"]:checked');
  const value = checked?.value;
  return value && (DIALECTS as readonly string[]).includes(value)
    ? value as Settings['dialect']
    : 'en-GB';
}

function renderDictionary(): void {
  dictionaryList.replaceChildren(...current.personalDictionary.map((word) => {
    const item = document.createElement('li');
    item.className = 'dictionary-item';
    const label = document.createElement('span');
    label.textContent = word;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'dictionary-remove';
    remove.dataset.removeWord = word;
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${word} from personal dictionary`);
    item.append(label, remove);
    return item;
  }));
  const empty = current.personalDictionary.length === 0;
  dictionaryEmpty.hidden = !empty;
  dictionaryList.hidden = empty;
  dictionaryClear.hidden = empty;
}

async function refreshDictionary(message: string): Promise<void> {
  current = await loadSettings();
  renderDictionary();
  dictionaryStatus.textContent = message;
}

function showResult(tone: 'ok' | 'error' | 'busy', message: string): void {
  saveResult.textContent = message;
  saveResult.setAttribute('data-tone', tone);
  saveResult.hidden = false;
}

async function refreshKeyUi(): Promise<void> {
  const kind = selectedKind();
  apiKeyField.hidden = kind === 'ollama';
  let remoteCustomEndpoint = false;
  try {
    remoteCustomEndpoint = !validateProviderEndpoint(
      kind,
      baseUrlInput.value || DEFAULT_BASE_URLS[kind],
    ).isLoopback;
  } catch {
    // The submit path supplies the actionable validation error.
  }
  cloudNotice.hidden = !CLOUD_KINDS.includes(kind) && !remoteCustomEndpoint;
  const keyHelp = document.getElementById('key-help')!;
  const keyHelpLink = document.getElementById('key-help-link') as HTMLAnchorElement;
  const helpUrl = KEY_HELP_URLS[kind];
  if (helpUrl) {
    keyHelpLink.href = helpUrl;
    keyHelpLink.textContent = `Create a free ${PROVIDER_LABELS[kind]} key ↗`;
    keyHelp.hidden = false;
  } else {
    keyHelp.hidden = true;
  }
  const saved = await hasSecret(kind);
  apiKeyInput.placeholder = saved ? 'Saved — leave blank to keep it' : 'Paste your key';
  removeKeyBtn.hidden = !saved;
}

function onProviderChange(previousKind: ProviderKind): void {
  const kind = selectedKind();
  const value = baseUrlInput.value.trim().replace(/\/+$/, '');
  const hasFixedEndpoint = CLOUD_KINDS.includes(kind);
  baseUrlInput.readOnly = hasFixedEndpoint;
  if (hasFixedEndpoint) {
    // Cloud providers have one official endpoint — never carry over a local
    // or custom address when switching to them.
    baseUrlInput.value = DEFAULT_BASE_URLS[kind];
  } else if (value === '' || value === DEFAULT_BASE_URLS[previousKind]) {
    baseUrlInput.value = DEFAULT_BASE_URLS[kind];
  }
  // Follow the same rule for the model: only replace it if the user hadn't
  // customised it for the previous provider.
  const model = modelInput.value.trim();
  if (model === '' || model === DEFAULT_MODELS[previousKind]) {
    modelInput.value = DEFAULT_MODELS[kind];
  }
  baseUrlHint.textContent =
    kind === 'ollama'
      ? `Default Ollama address. Allow only this extension origin: OLLAMA_ORIGINS=${extensionOrigin()}. Do not use a wildcard.`
      : kind === 'openai-compat'
        ? 'Default LM Studio address. Edit it for any OpenAI-compatible custom server. Enable CORS in LM Studio.'
        : 'Official API address is fixed for this provider. To use a custom server, choose LM Studio / OpenAI-compatible.';
  modelList.replaceChildren();
  modelsHint.hidden = true;
  void refreshKeyUi();
}

/**
 * Validates and saves the form. Returns true on success. Kept synchronous up
 * to the optional permission request — chrome.permissions.request must run
 * inside the user-gesture context.
 */
async function persist(): Promise<boolean> {
  const alreadyAccepted = current.dataConsentVersion >= CURRENT_DATA_CONSENT_VERSION;
  if (!alreadyAccepted && !consentCheckbox.checked) {
    showResult('error', 'Review the privacy disclosure and tick the consent box before saving.');
    consentCheckbox.focus();
    return false;
  }

  const blocklist = parseSiteHostList(blocklistArea.value);
  if (blocklist.invalid.length > 0) {
    showResult(
      'error',
      `Use a hostname or web URL for each blocked site. Check: ${blocklist.invalid.slice(0, 3).join(', ')}`,
    );
    blocklistArea.focus();
    return false;
  }

  const kind = selectedKind();
  let endpoint: ReturnType<typeof validateProviderEndpoint>;
  try {
    endpoint = validateProviderEndpoint(kind, baseUrlInput.value || DEFAULT_BASE_URLS[kind]);
  } catch (err) {
    showResult(
      'error',
      err instanceof ProviderEndpointError ? err.message : 'That server address is not valid.',
    );
    return false;
  }

  if (endpoint.requiresPermission) {
    // This is deliberately the first await in the submit path. Chrome requires
    // optional permission requests to remain inside the user's click gesture.
    const granted = await requestProviderOriginPermission(endpoint);
    if (!granted) {
      showResult(
        'error',
        `Permission for ${endpoint.origin} was declined, so Inkwell can’t reach it. Nothing was saved.`,
      );
      return false;
    }
  }

  const settings: Settings = {
    ...current,
    dataConsentVersion: consentCheckbox.checked
      ? CURRENT_DATA_CONSENT_VERSION
      : current.dataConsentVersion,
    provider: {
      kind,
      baseUrl: endpoint.baseUrl,
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
    disabledSites: blocklist.hosts,
  };

  await saveSettings(settings);
  current = settings;
  updateConsentUi(current.dataConsentVersion >= CURRENT_DATA_CONSENT_VERSION);

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

baseUrlInput.addEventListener('input', () => void refreshKeyUi());

dictionaryAdd.addEventListener('click', () => {
  void (async () => {
    const word = dictionaryInput.value.trim();
    if (!word || !/^[\p{L}]+(?:['’\-][\p{L}]+)*$/u.test(word)) {
      dictionaryStatus.textContent = 'Enter a single word. Apostrophes and hyphens are allowed.';
      dictionaryInput.focus();
      return;
    }
    dictionaryAdd.disabled = true;
    const added = await addPersonalDictionaryWord(word);
    dictionaryAdd.disabled = false;
    if (!added) {
      dictionaryStatus.textContent = 'That word is already saved, or the dictionary is full.';
      return;
    }
    dictionaryInput.value = '';
    await refreshDictionary(`${word} added.`);
  })();
});

dictionaryInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  dictionaryAdd.click();
});

dictionaryList.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-remove-word]');
  if (!button?.dataset.removeWord) return;
  void (async () => {
    const word = button.dataset.removeWord!;
    button.disabled = true;
    await removePersonalDictionaryWord(word);
    await refreshDictionary(`${word} removed.`);
  })();
});

dictionaryClear.addEventListener('click', () => {
  void (async () => {
    dictionaryClear.disabled = true;
    await clearPersonalDictionary();
    dictionaryClear.disabled = false;
    await refreshDictionary('Personal dictionary cleared.');
  })();
});

async function init(): Promise<void> {
  current = await loadSettings();
  const accepted = current.dataConsentVersion >= CURRENT_DATA_CONSENT_VERSION;
  updateConsentUi(accepted);
  if (!accepted) {
    requestAnimationFrame(() => consentTitle.focus());
  }
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
  renderDictionary();
  onProviderChange(current.provider.kind);
}

void init();
