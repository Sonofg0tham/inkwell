import '../../brand-theme.css';
import './style.css';
import {
  createDocument,
  getDocument,
  updateDocument,
  moveToTrash,
  restoreFromTrash,
  getDocumentsMetadata,
  deleteDocumentPermanently,
  getStorageUsage,
  type DocumentMetadata,
} from '../../lib/storage/documents';
import {
  addPersonalDictionaryWord,
  hasSecret,
  loadSettings,
  saveSecret,
  saveSettings,
} from '../../lib/settings/store';
import { PortClient } from '../../lib/content/portClient';
import { chunkText } from '../../lib/checker/chunker';
import { fnvHash } from '../../lib/checker/hash';
import { measureTextareaRanges } from '../../lib/ui/textareaMirror';
import { applyEdits, replaceRange, restore, snapshot, type Snapshot } from '../../lib/ui/textEdit';
import { sendTyped } from '../../lib/messaging/typed';
import { providerUsesRemoteEndpoint } from '../../lib/providers/validation';
import {
  CURRENT_DATA_CONSENT_VERSION,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  KEY_HELP_URLS,
  PROVIDER_KINDS,
  PROVIDER_LABELS,
  type ProviderKind,
  type Settings,
} from '../../lib/settings/schema';
import { blottySvg } from '../../lib/ui/blotty';
import { importFile, ImportError } from '../../lib/import';
import { exportDocument, type ExportFormat } from '../../lib/export';
import {
  chooseSyncFolder,
  forgetSyncFolder,
  getSyncFolder,
  isFolderSyncSupported,
  syncDocumentsToFolder,
  type SyncableDoc,
} from '../../lib/storage/folderSync';

// ── Module state ────────────────────────────────────────────────
let activeDocumentId: string | null = null;
let activeSuggestions: Suggestion[] = [];
let activeFilter: string = 'all';
const ignoredDocumentWords = new Set<string>();
let portClient: PortClient | null = null;
let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let checkTimeout: ReturnType<typeof setTimeout> | null = null;
let latestRunId: string | null = null;
const activeRequestIds = new Set<string>();
const MAX_CONCURRENT_DOCUMENT_CHECKS = 4;
const MAX_LOCAL_CHUNKS_PER_RUN = 60;
const MAX_REMOTE_CHUNKS_PER_RUN = 10;
let isChecking = false;
let checkPending = false;
let checkerError: { code: string; hint: string } | null = null;
/** Hash of the text the currently displayed verdict actually describes. */
let checkedHash: string | null = null;
/** Issues the model reported for that text that could not be located in it. */
let droppedCount = 0;
let droppedReasons: string[] = [];
let incompleteHint: string | null = null;
let lastCheck: { model: string; at: number } | null = null;
let workspaceContinuation: WorkspaceContinuation | null = null;
let dashboardStarted = false;
let consentGateBound = false;

// After a 429, stop auto-checking for a while instead of burning quota on
// every typing pause (free cloud tiers allow ~10 requests/minute).
let rateLimitCooldownMs = 30_000;
let cooldownUntil = 0;
let cooldownRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function __setRateLimitCooldownForTests(ms: number) {
  rateLimitCooldownMs = ms;
}

function runCheckerFromCurrentProgress(): void {
  void runChecker({ continueExisting: workspaceContinuation !== null });
}

function forceCheckerFromCurrentProgress(): void {
  if (cooldownRetryTimer) {
    clearTimeout(cooldownRetryTimer);
    cooldownRetryTimer = null;
  }
  cooldownUntil = 0;
  checkerError = null;
  runCheckerFromCurrentProgress();
}

function scheduleCooldownRetry() {
  if (cooldownRetryTimer) return;
  const delay = Math.max(0, cooldownUntil - Date.now()) + 50;
  cooldownRetryTimer = setTrackedTimeout(() => {
    cooldownRetryTimer = null;
    runCheckerFromCurrentProgress();
  }, delay);
}

/** Text-safe interpolation for any user- or model-supplied string. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Suggestion {
  id: string;
  type: string;
  start: number;
  end: number;
  original: string;
  replacement: string;
  explanation: string;
}

interface WorkspaceContinuation {
  documentHash: string;
  nextChunkIndex: number;
  totalChunks: number;
  suggestions: Suggestion[];
  droppedCount: number;
  droppedReasons: string[];
  incompleteHint: string | null;
  model: string;
}

function spellingWordKey(word: string): string {
  return word.replaceAll('\u2019', "'").toLocaleLowerCase('en');
}

function ignoreSpellingWord(word: string): void {
  const key = spellingWordKey(word);
  ignoredDocumentWords.add(key);
  activeSuggestions = activeSuggestions.filter(
    (suggestion) => suggestion.type !== 'spelling' || spellingWordKey(suggestion.original) !== key,
  );
  renderSuggestions();
}

async function addSpellingToDictionary(issue: Suggestion, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = 'Saving\u2026';
  try {
    const saved = await addPersonalDictionaryWord(issue.original);
    const settings = saved ? null : await loadSettings();
    const alreadySaved = settings?.personalDictionary.some(
      (word) => spellingWordKey(word) === spellingWordKey(issue.original),
    );
    if (saved || alreadySaved) {
      ignoreSpellingWord(issue.original);
      return;
    }
    button.disabled = false;
    button.textContent = 'Could not save. Try again';
  } catch {
    button.disabled = false;
    button.textContent = 'Could not save. Try again';
  }
}

// ── Helper: tracked timeouts for test environments ───────────────
function setTrackedTimeout(cb: () => void, delay: number) {
  const id = setTimeout(cb, delay);
  if (typeof globalThis !== 'undefined') {
    // @ts-ignore
    if (!globalThis.__activeTimeouts) { // @ts-ignore
      globalThis.__activeTimeouts = [];
    } // @ts-ignore
    globalThis.__activeTimeouts.push(id);
  }
  return id;
}

// ── Readability / score ──────────────────────────────────────────
function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  const matches = word.match(/[aeiouy]+/g);
  let count = matches ? matches.length : 1;
  if (word.endsWith('e')) count--;
  return count <= 0 ? 1 : count;
}

function calculateReadability(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (!words.length) return 100;
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length || 1;
  const syllables = words.reduce((acc, w) => acc + countSyllables(w), 0);
  const score = 206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function updateScorePill(text: string) {
  const score = calculateReadability(text);
  const el = document.getElementById('readability-score');
  if (!el) return;
  el.textContent = `Readability: ${score}`;
  el.classList.remove('score-good', 'score-ok', 'score-poor');
  if (score >= 65) el.classList.add('score-good');
  else if (score >= 40) el.classList.add('score-ok');
  else el.classList.add('score-poor');
}

function updateWordCount(text: string) {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  const count = text.trim().length === 0 ? 0 : words.length;
  const el = document.getElementById('word-count');
  if (el) el.textContent = `${count} word${count !== 1 ? 's' : ''}`;
}

// ── Text formatting ──────────────────────────────────────────────
function formatText(marker: string) {
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.substring(start, end);
  const replacement = selected.length ? `${marker}${selected}${marker}` : `${marker}${marker}`;
  const newValue = value.substring(0, start) + replacement + value.substring(end);
  textarea.value = newValue;
  // Preserve selection around the wrapped content
  const newStart = start + marker.length;
  const newEnd   = selected.length ? start + marker.length + selected.length : start + marker.length;
  textarea.setSelectionRange(newStart, newEnd);
  // Update stats without re-focusing (which resets selection in some environments)
  updateWordCount(newValue);
  updateScorePill(newValue);
  triggerAutoSave();
  triggerChecker();
}


// ── Auto-save ────────────────────────────────────────────────────
function triggerAutoSave() {
  if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
  autoSaveTimeout = setTrackedTimeout(() => { void saveCurrentDocument(); }, 500);
}

async function saveCurrentDocument() {
  if (!activeDocumentId) return;
  const titleEl = document.getElementById('editor-title') as HTMLInputElement;
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  if (!textarea) return;
  try {
    await updateDocument(activeDocumentId, {
      title: titleEl?.value || 'Untitled document',
      content: textarea.value,
    });
    const warning = document.getElementById('storage-warning');
    if (warning) warning.remove();
    await renderDocLists();
  } catch (e) {
    console.error('Auto-save failed:', e);
    // Show storage quota warning
    const wordCountEl = document.getElementById('word-count');
    if (wordCountEl && !document.getElementById('storage-warning')) {
      const warning = document.createElement('span');
      warning.id = 'storage-warning';
      warning.textContent = ' (Storage Quota Exceeded!)';
      warning.style.color = 'red';
      wordCountEl.appendChild(warning);
    }
  }
}

async function flushCurrentDocument() {
  if (autoSaveTimeout) { clearTimeout(autoSaveTimeout); autoSaveTimeout = null; }
  await saveCurrentDocument();
}

// ── Checker ──────────────────────────────────────────────────────
function triggerChecker() {
  if (checkTimeout) clearTimeout(checkTimeout);
  cancelActiveChecks();
  workspaceContinuation = null;
  // Mark a check as pending the instant the user types, so the panel never
  // shows a stale verdict for text that has since changed.
  checkPending = true;
  incompleteHint = null;
  updateWritingPulse();
  checkTimeout = setTrackedTimeout(() => { void runChecker(); }, 1000);
}

function cancelActiveChecks(): void {
  latestRunId = null;
  if (activeRequestIds.size > 0) {
    portClient?.cancel([...activeRequestIds]);
    activeRequestIds.clear();
  }
  isChecking = false;
}

async function runChecker(options: { continueExisting?: boolean } = {}) {
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  if (!textarea) return;
  const text = textarea.value;

  if (!text.trim()) {
    activeSuggestions = [];
    checkerError = null;
    isChecking = false;
    checkPending = false;
    droppedCount = 0;
    incompleteHint = null;
    workspaceContinuation = null;
    checkedHash = null;
    cancelActiveChecks();
    renderSuggestions();
    return;
  }

  if (!portClient) {
    try { portClient = new PortClient(); } catch { return; }
  }
  if (portClient.dead) { renderConnectionFailed(); return; }
  const checkerClient = portClient;

  // Still cooling down after a rate limit — wait it out, then retry once.
  if (Date.now() < cooldownUntil) {
    scheduleCooldownRetry();
    return;
  }

  cancelActiveChecks();
  const runId = crypto.randomUUID();
  latestRunId = runId;
  const documentHash = fnvHash(text);
  const settings = await loadSettings();
  if (latestRunId !== runId || textarea.value !== text) return;
  const chunks = chunkText(text, settings.dialect);
  const savedContinuation =
    options.continueExisting === true
    && workspaceContinuation?.documentHash === documentHash
    && workspaceContinuation.totalChunks === chunks.length
    && workspaceContinuation.nextChunkIndex < chunks.length
      ? workspaceContinuation
      : null;
  if (!savedContinuation) workspaceContinuation = null;
  const chunkLimit = providerUsesRemoteEndpoint(settings.provider.kind, settings.provider.baseUrl)
    ? MAX_REMOTE_CHUNKS_PER_RUN
    : MAX_LOCAL_CHUNKS_PER_RUN;
  const batchStart = savedContinuation?.nextChunkIndex ?? 0;
  const batchEnd = Math.min(chunks.length, batchStart + chunkLimit);

  isChecking = true;
  checkPending = false;
  updateWritingPulse();
  updateCheckButton();

  if (chunks.length === 0) {
    latestRunId = null;
    isChecking = false;
    checkerError = null;
    activeSuggestions = [];
    droppedCount = 0;
    droppedReasons = [];
    incompleteHint = null;
    workspaceContinuation = null;
    checkedHash = documentHash;
    renderSuggestions();
    return;
  }

  let remaining = batchEnd - batchStart;
  const merged: Suggestion[] = savedContinuation ? [...savedContinuation.suggestions] : [];
  let mergedDropped = savedContinuation?.droppedCount ?? 0;
  const mergedReasons = new Set<string>(savedContinuation?.droppedReasons ?? []);
  let mergedIncomplete: string | null = savedContinuation?.incompleteHint ?? null;
  let model = savedContinuation?.model ?? '';

  const finish = (): void => {
    if (latestRunId !== runId || remaining > 0) return;
    latestRunId = null;
    isChecking = false;
    checkerError = null;
    cooldownUntil = 0;
    checkedHash = documentHash;
    droppedCount = mergedDropped;
    droppedReasons = [...mergedReasons].slice(0, 3);
    incompleteHint = mergedIncomplete;
    lastCheck = { model, at: Date.now() };
    workspaceContinuation = batchEnd < chunks.length
      ? {
          documentHash,
          nextChunkIndex: batchEnd,
          totalChunks: chunks.length,
          suggestions: merged,
          droppedCount: mergedDropped,
          droppedReasons: [...mergedReasons].slice(0, 3),
          incompleteHint: mergedIncomplete,
          model,
        }
      : null;
    activeSuggestions = merged
      .filter(
        (suggestion) =>
          suggestion.type !== 'spelling'
          || !ignoredDocumentWords.has(spellingWordKey(suggestion.original)),
      )
      .sort((a, b) => a.start - b.start || a.end - b.end);
    renderSuggestions();
  };

  let nextChunkIndex = batchStart;
  const dispatchNext = (): void => {
    if (latestRunId !== runId) return;
    while (
      nextChunkIndex < batchEnd
      && activeRequestIds.size < MAX_CONCURRENT_DOCUMENT_CHECKS
    ) {
      const chunk = chunks[nextChunkIndex++]!;
      const requestId = crypto.randomUUID();
      activeRequestIds.add(requestId);
      checkerClient.check(requestId, chunk.hash, chunk.text, (response) => {
        activeRequestIds.delete(requestId);
        if (latestRunId !== runId) return;
        if (response.t === 'error') {
          const remainingIds = [...activeRequestIds];
          activeRequestIds.clear();
          if (remainingIds.length > 0) checkerClient.cancel(remainingIds);
          latestRunId = null;
          isChecking = false;
          checkerError = { code: response.code, hint: response.hint };
          if (response.code === 'rate_limit' || response.code === 'unavailable') {
            cooldownUntil = Date.now() + rateLimitCooldownMs;
            scheduleCooldownRetry();
          }
          console.error('Checker error:', response.hint);
          renderSuggestions();
          return;
        }

        model = response.model || model;
        if (response.incomplete?.hint && !mergedIncomplete) {
          mergedIncomplete = response.incomplete.hint;
        }
        mergedDropped += Math.max(0, Math.floor(Number(response.dropped) || 0));
        for (const reason of response.droppedReasons ?? []) {
          if (typeof reason === 'string') mergedReasons.add(reason);
        }
        for (const issue of response.issues) {
          const start = chunk.docOffset + issue.start;
          merged.push({
            id: `${issue.id}@${start}`,
            type: issue.type,
            start,
            end: chunk.docOffset + issue.end,
            original: issue.original,
            replacement: issue.replacement,
            explanation: issue.explanation,
          });
        }
        remaining--;
        dispatchNext();
        finish();
      });
    }
  };

  dispatchNext();

  if (checkerClient.dead) renderConnectionFailed();
}

function renderConnectionFailed() {
  const list = document.getElementById('suggestions-list');
  if (!list) return;
  list.innerHTML = `
    <div class="connection-error">
      <p>Could not reach the Inkwell background service.</p>
      <button id="btn-reconnect-port" class="btn-ghost btn-sm">Retry</button>
    </div>`;
  document.getElementById('btn-reconnect-port')?.addEventListener('click', () => {
    portClient?.destroy();
    portClient = null;
    forceCheckerFromCurrentProgress();
  });
}

// ── Suggestions rendering ────────────────────────────────────────
function renderSuggestions() {
  const list = document.getElementById('suggestions-list');
  const emptyEl = document.getElementById('suggestions-empty');
  const idleEl = document.getElementById('suggestions-idle');
  const overlay = document.getElementById('underline-overlay');
  if (!list) return;
  list.innerHTML = '';
  if (overlay) overlay.innerHTML = '';

  updateWritingPulse();
  updateEditActions();
  updateCheckButton();

  if (idleEl) idleEl.style.display = 'none';

  // Provider/connection failure: show an actionable card instead of silence.
  if (checkerError) {
    if (emptyEl) emptyEl.style.display = 'none';
    const isRateLimit = checkerError.code === 'rate_limit';
    const errorCard = document.createElement('div');
    errorCard.className = 'checker-error';
    errorCard.setAttribute('role', 'alert');
    errorCard.innerHTML = `
      <div class="checker-error-title">${isRateLimit ? 'Taking a short breather' : 'Inkwell can’t check right now'}</div>
      <p class="checker-error-hint">${esc(checkerError.hint)}${isRateLimit ? ' Inkwell has paused checking and will retry on its own.' : ''}</p>
      <div class="checker-error-actions">
        <button class="btn-retry-check btn-primary btn-sm">Try again</button>
        <button class="btn-error-settings btn-ghost btn-sm">Provider settings</button>
      </div>`;
    errorCard.querySelector('.btn-retry-check')?.addEventListener('click', forceCheckerFromCurrentProgress);
    errorCard.querySelector('.btn-error-settings')?.addEventListener('click', () => {
      void flushCurrentDocument();
      hideEditor();
      showSettings();
    });
    list.appendChild(errorCard);
    return;
  }

  const filtered = activeFilter === 'all'
    ? activeSuggestions
    : activeSuggestions.filter((s) => s.type === activeFilter);

  if (workspaceContinuation) {
    if (emptyEl) emptyEl.style.display = 'none';
    const card = document.createElement('div');
    card.className = 'checker-partial workspace-check-paused';
    card.setAttribute('role', 'status');
    card.innerHTML = `
      <div class="checker-partial-title">Large document check paused</div>
      <p class="checker-partial-hint">
        Checked sections 1 to ${workspaceContinuation.nextChunkIndex} of ${workspaceContinuation.totalChunks}.
        Continue when you are ready to use the model for the next batch.
      </p>
      <div class="checker-error-actions">
        <button class="btn-continue-check btn-primary btn-sm">Continue check</button>
      </div>`;
    card.querySelector('.btn-continue-check')?.addEventListener('click', () => {
      void runChecker({ continueExisting: true });
    });
    list.appendChild(card);
  }

  if (incompleteHint) {
    if (emptyEl) emptyEl.style.display = 'none';
    const card = document.createElement('div');
    card.className = 'checker-partial';
    card.setAttribute('role', 'status');
    card.innerHTML = `
      <div class="checker-partial-title">Contextual check incomplete</div>
      <p class="checker-partial-hint">
        Inkwell kept the local spelling and rule suggestions it could verify. Grammar, clarity and tone may be incomplete.
      </p>
      <p class="checker-partial-reason">${esc(incompleteHint)}</p>
      <div class="checker-error-actions">
        <button class="btn-retry-check btn-primary btn-sm">Try contextual check again</button>
        <button class="btn-error-settings btn-ghost btn-sm">Provider settings</button>
      </div>`;
    card.querySelector('.btn-retry-check')?.addEventListener('click', forceCheckerFromCurrentProgress);
    card.querySelector('.btn-error-settings')?.addEventListener('click', () => {
      void flushCurrentDocument();
      hideEditor();
      showSettings();
    });
    list.appendChild(card);
  }

  // The model reported problems that couldn't be matched to the text. Saying
  // "looks clear" here would be a lie, so say exactly what happened.
  if (droppedCount > 0 && activeSuggestions.length === 0) {
    if (emptyEl) emptyEl.style.display = 'none';
    const card = document.createElement('div');
    card.className = 'checker-partial';
    card.setAttribute('role', 'status');
    card.innerHTML = `
      <div class="checker-partial-title">Couldn’t use ${droppedCount} suggestion${droppedCount === 1 ? '' : 's'}</div>
      <p class="checker-partial-hint">
        Your model flagged ${droppedCount} problem${droppedCount === 1 ? '' : 's'}, but quoted text that isn’t in your
        document or replied in a format Inkwell couldn’t read, so it can’t show you where.
        Try checking again, or switch to a stronger model.
      </p>
      ${droppedReasons.length ? `<p class="checker-partial-reason">${esc(droppedReasons[0]!)}</p>` : ''}
      <div class="checker-error-actions">
        <button class="btn-retry-check btn-primary btn-sm">Check again</button>
        <button class="btn-error-settings btn-ghost btn-sm">Change model</button>
      </div>`;
    card.querySelector('.btn-retry-check')?.addEventListener('click', forceCheckerFromCurrentProgress);
    card.querySelector('.btn-error-settings')?.addEventListener('click', () => {
      void flushCurrentDocument();
      hideEditor();
      showSettings();
    });
    list.appendChild(card);
    return;
  }

  if (filtered.length === 0) {
    const emptyCopy = emptyEl?.querySelector<HTMLElement>('.sugg-empty-text');
    if (emptyCopy) {
      emptyCopy.textContent = activeFilter === 'all'
        ? 'Writing looks clear. Inkwell will keep monitoring as you type.'
        : `No ${activeFilter} suggestions in this document.`;
    }
    if (emptyEl) emptyEl.style.display = incompleteHint || workspaceContinuation ? 'none' : 'flex';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  filtered.forEach((issue) => {
    const card = document.createElement('div');
    card.className = `suggestion-card ${issue.type}`;
    card.setAttribute('role', 'listitem');
    card.dataset.id = issue.id;
    card.innerHTML = `
      <div class="suggestion-type">${esc(issue.type)}</div>
      <div class="suggestion-original"><del>${esc(issue.original)}</del> → <ins>${esc(issue.replacement)}</ins></div>
      <div class="suggestion-explanation">${esc(issue.explanation)}</div>
      <div class="suggestion-actions">
        <button type="button" class="btn-accept-suggestion">Accept</button>
        <button type="button" class="btn-dismiss-suggestion">Dismiss</button>
        ${issue.type === 'spelling' ? `
          <button type="button" class="btn-add-dictionary">Add to dictionary</button>
          <button type="button" class="btn-ignore-all">Ignore all</button>
        ` : ''}
      </div>`;

    card.querySelector('.btn-accept-suggestion')?.addEventListener('click', () => acceptSuggestion(issue));
    card.querySelector('.btn-dismiss-suggestion')?.addEventListener('click', () => dismissSuggestion(issue.id));
    card.querySelector<HTMLButtonElement>('.btn-add-dictionary')?.addEventListener('click', (event) => {
      void addSpellingToDictionary(issue, event.currentTarget as HTMLButtonElement);
    });
    card.querySelector('.btn-ignore-all')?.addEventListener('click', () => ignoreSpellingWord(issue.original));
    list.appendChild(card);
  });

  renderUnderlines(filtered);
}

// ── Squiggly underlines (mirror-measured, scroll-synced) ────────
function renderUnderlines(issues: Suggestion[]) {
  const overlay = document.getElementById('underline-overlay');
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement | null;
  if (!overlay) return;
  overlay.innerHTML = '';
  if (!textarea || issues.length === 0) return;

  const fragments = measureTextareaRanges(
    textarea,
    issues.map((i) => ({ start: i.start, end: i.end })),
  );

  issues.forEach((issue, index) => {
    const rects = fragments[index] ?? [];
    const spans = rects.length > 0 ? rects : [null];
    for (const rect of spans) {
      const underline = document.createElement('span');
      underline.className = `squiggly-underline ${issue.type}`;
      underline.dataset.id = issue.id;
      if (rect) {
        underline.style.left = `${rect.left}px`;
        underline.style.top = `${rect.top}px`;
        underline.style.width = `${rect.width}px`;
        underline.style.height = `${rect.height}px`;
      } else {
        // No layout engine (unit tests) or scrolled out of view — keep the
        // element for interaction contracts but park it off-screen.
        underline.style.left = '-9999px';
        underline.style.top = '0px';
        underline.style.width = '0px';
      }
      underline.addEventListener('click', () => {
        document.querySelectorAll('.suggestion-card').forEach((c) => c.classList.remove('highlighted'));
        const targetCard = document.querySelector(`.suggestion-card[data-id="${issue.id}"]`);
        if (targetCard) {
          targetCard.classList.add('highlighted');
          targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
      overlay.appendChild(underline);
    }
  });
}

let underlineRepaintScheduled = false;
function scheduleUnderlineRepaint() {
  if (underlineRepaintScheduled) return;
  underlineRepaintScheduled = true;
  requestAnimationFrame(() => {
    underlineRepaintScheduled = false;
    const filtered = activeFilter === 'all'
      ? activeSuggestions
      : activeSuggestions.filter((s) => s.type === activeFilter);
    renderUnderlines(filtered);
  });
}

/** Footer line: which model produced the verdict on screen, and when. */
function updateCheckProvenance() {
  const el = document.getElementById('check-provenance');
  if (!el) return;
  if (!lastCheck) {
    el.textContent = '';
    el.hidden = true;
    return;
  }
  const time = new Date(lastCheck.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  el.textContent = lastCheck.model
    ? `Last checked ${time} with ${lastCheck.model}`
    : `Last checked ${time}`;
  el.hidden = false;
}

function updateWritingPulse() {
  const pulse = document.getElementById('writing-pulse');
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement | null;
  if (!pulse) return;

  const count = activeSuggestions.length;
  const text = textarea?.value ?? '';
  const hasText = Boolean(text.trim());
  // "Clear" may only be claimed for text that was actually checked.
  const verdictMatchesText = hasText && checkedHash !== null && checkedHash === fnvHash(text);

  if (checkerError) {
    pulse.textContent = 'Checker unavailable';
    pulse.dataset.state = 'error';
  } else if (isChecking || checkPending) {
    pulse.textContent = 'Checking…';
    pulse.dataset.state = 'checking';
  } else if (!hasText) {
    pulse.textContent = 'Start writing to review';
    pulse.dataset.state = 'idle';
  } else if (!verdictMatchesText) {
    pulse.textContent = 'Not checked yet';
    pulse.dataset.state = 'unchecked';
  } else if (workspaceContinuation || incompleteHint || (droppedCount > 0 && count === 0)) {
    pulse.textContent = 'Needs a closer look';
    pulse.dataset.state = 'partial';
  } else if (count === 0) {
    pulse.textContent = 'Writing looks clear';
    pulse.dataset.state = 'clear';
  } else {
    pulse.textContent = `${count} suggestion${count === 1 ? '' : 's'} to review`;
    pulse.dataset.state = 'review';
  }

  updateCheckProvenance();

  document.querySelectorAll<HTMLButtonElement>('.sugg-tab').forEach((tab) => {
    const filter = tab.dataset.filter || 'all';
    const tabCount = filter === 'all'
      ? count
      : activeSuggestions.filter((suggestion) => suggestion.type === filter).length;
    const countEl = tab.querySelector('.tab-count');
    if (countEl) countEl.textContent = tabCount ? String(tabCount) : '';
  });
}

function updateCheckButton() {
  const button = document.getElementById('btn-check-now') as HTMLButtonElement | null;
  if (!button) return;
  button.textContent = workspaceContinuation ? 'Continue check' : 'Check now';
  button.disabled = isChecking;
}

// ── Undo ─────────────────────────────────────────────────────────
const UNDO_LIMIT = 50;
let undoStack: Snapshot[] = [];

function pushUndo(textarea: HTMLTextAreaElement) {
  undoStack.push(snapshot(textarea));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  updateEditActions();
}

function undoLastFix() {
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  const snap = undoStack.pop();
  if (!textarea || !snap) return;
  restore(textarea, snap);
  updateEditActions();
  handleTextareaInput();
  if (autoSaveTimeout) { clearTimeout(autoSaveTimeout); autoSaveTimeout = null; }
  void saveCurrentDocument();
}

/** Keeps the Fix all / Undo controls in step with what is actually possible. */
function updateEditActions() {
  const undo = document.getElementById('btn-undo') as HTMLButtonElement | null;
  if (undo) undo.disabled = undoStack.length === 0;

  const fixAll = document.getElementById('btn-fix-all') as HTMLButtonElement | null;
  if (fixAll) {
    const count = activeSuggestions.length;
    fixAll.hidden = count === 0;
    fixAll.textContent = `Fix all ${count}`;
  }
}

function acceptSuggestion(issue: Suggestion) {
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  if (!textarea) return;
  // Snapshot before the edit so Undo can put it back even when the browser's
  // own history is unavailable.
  pushUndo(textarea);
  const offset = issue.replacement.length - (issue.end - issue.start);
  replaceRange(textarea, issue.start, issue.end, issue.replacement);
  activeSuggestions = activeSuggestions
    .filter((s) => s.id !== issue.id)
    .map((s) => s.start >= issue.end ? { ...s, start: s.start + offset, end: s.end + offset } : s);
  renderSuggestions();
  handleTextareaInput();
  if (autoSaveTimeout) { clearTimeout(autoSaveTimeout); autoSaveTimeout = null; }
  void saveCurrentDocument();
}

/** Applies every current suggestion as one undoable step. */
function fixAllSuggestions() {
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  if (!textarea || activeSuggestions.length === 0) return;
  pushUndo(textarea);
  const applied = applyEdits(
    textarea,
    activeSuggestions.map((s) => ({
      start: s.start,
      end: s.end,
      original: s.original,
      replacement: s.replacement,
    })),
  );
  if (applied === 0) {
    undoStack.pop(); // nothing changed — don't leave a no-op undo step
    updateEditActions();
    return;
  }
  activeSuggestions = [];
  renderSuggestions();
  handleTextareaInput();
  if (autoSaveTimeout) { clearTimeout(autoSaveTimeout); autoSaveTimeout = null; }
  void saveCurrentDocument();
}

function dismissSuggestion(id: string) {
  activeSuggestions = activeSuggestions.filter((s) => s.id !== id);
  renderSuggestions();
}

// ── Editor input handler ─────────────────────────────────────────
function handleTextareaInput() {
  const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
  if (!textarea) return;
  const text = textarea.value;
  updateWordCount(text);
  updateScorePill(text);
  triggerAutoSave();
  triggerChecker();
}

// ── View switching (using style.display for test compatibility) ──
function showDocList() {
  const docList = document.getElementById('document-list');
  const documentIndexHeading = document.querySelector<HTMLElement>('.document-index-heading');
  const trashList = document.getElementById('trash-list');
  const settingsView = document.getElementById('settings-view');
  const trashEmpty = document.getElementById('trash-empty');
  const emptyTrashBtn = document.getElementById('btn-empty-trash');
  const hubHeading = document.getElementById('hub-heading');
  const newDocHubBtn = document.getElementById('btn-new-doc-hub');

  if (docList) docList.style.display = 'block';
  if (documentIndexHeading) documentIndexHeading.style.display = 'block';
  if (trashList) trashList.style.display = 'none';
  if (trashEmpty) trashEmpty.style.display = 'none';
  if (settingsView) settingsView.style.display = 'none';
  if (emptyTrashBtn) emptyTrashBtn.style.display = 'none';
  if (newDocHubBtn) newDocHubBtn.style.display = 'inline-flex';
  if (hubHeading) hubHeading.textContent = 'Docs';
  const searchRow = document.getElementById('hub-search-row');
  if (searchRow) searchRow.style.display = 'flex';

  ['nav-active-docs', 'nav-trash', 'nav-settings'].forEach((id) =>
    document.getElementById(id)?.classList.remove('active')
  );
  document.getElementById('nav-active-docs')?.classList.add('active');
  document.getElementById('nav-active-docs')?.setAttribute('aria-current', 'page');
}

function showTrashList() {
  const docList = document.getElementById('document-list');
  const documentIndexHeading = document.querySelector<HTMLElement>('.document-index-heading');
  const trashList = document.getElementById('trash-list');
  const docsEmpty = document.getElementById('docs-empty');
  const settingsView = document.getElementById('settings-view');
  const emptyTrashBtn = document.getElementById('btn-empty-trash');
  const hubHeading = document.getElementById('hub-heading');
  const newDocHubBtn = document.getElementById('btn-new-doc-hub');

  if (docList) docList.style.display = 'none';
  if (documentIndexHeading) documentIndexHeading.style.display = 'none';
  if (docsEmpty) docsEmpty.style.display = 'none';
  if (trashList) trashList.style.display = 'block';
  if (settingsView) settingsView.style.display = 'none';
  if (emptyTrashBtn) emptyTrashBtn.style.display = 'inline-flex';
  if (newDocHubBtn) newDocHubBtn.style.display = 'none';
  if (hubHeading) hubHeading.textContent = 'Trash';
  const searchRow = document.getElementById('hub-search-row');
  if (searchRow) searchRow.style.display = 'flex';

  ['nav-active-docs', 'nav-trash', 'nav-settings'].forEach((id) =>
    document.getElementById(id)?.classList.remove('active')
  );
  document.getElementById('nav-trash')?.classList.add('active');
  document.getElementById('nav-trash')?.setAttribute('aria-current', 'page');
}

function showSettings() {
  const docList = document.getElementById('document-list');
  const documentIndexHeading = document.querySelector<HTMLElement>('.document-index-heading');
  const trashList = document.getElementById('trash-list');
  const docsEmpty = document.getElementById('docs-empty');
  const trashEmpty = document.getElementById('trash-empty');
  const settingsView = document.getElementById('settings-view');
  const emptyTrashBtn = document.getElementById('btn-empty-trash');
  const hubHeading = document.getElementById('hub-heading');
  const newDocHubBtn = document.getElementById('btn-new-doc-hub');

  if (docList) docList.style.display = 'none';
  if (documentIndexHeading) documentIndexHeading.style.display = 'none';
  if (docsEmpty) docsEmpty.style.display = 'none';
  if (trashList) trashList.style.display = 'none';
  if (trashEmpty) trashEmpty.style.display = 'none';
  if (settingsView) settingsView.style.display = 'block';
  if (emptyTrashBtn) emptyTrashBtn.style.display = 'none';
  if (newDocHubBtn) newDocHubBtn.style.display = 'none';
  if (hubHeading) hubHeading.textContent = 'Settings';
  const searchRow = document.getElementById('hub-search-row');
  if (searchRow) searchRow.style.display = 'none';

  ['nav-active-docs', 'nav-trash', 'nav-settings'].forEach((id) =>
    document.getElementById(id)?.classList.remove('active')
  );
  document.getElementById('nav-settings')?.classList.add('active');
  document.getElementById('nav-settings')?.setAttribute('aria-current', 'page');
}

/** Opens the focused editor workspace: the docs hub is replaced, not stacked. */
function showEditor() {
  const editor = document.getElementById('editor-container');
  if (editor) editor.style.display = 'flex';
  const hub = document.querySelector<HTMLElement>('.hub-view');
  if (hub) hub.style.display = 'none';
  const idleEl = document.getElementById('suggestions-idle');
  if (idleEl) idleEl.style.display = 'none';
}

function hideEditor() {
  const editor = document.getElementById('editor-container');
  if (editor) editor.style.display = 'none';
  const hub = document.querySelector<HTMLElement>('.hub-view');
  if (hub) hub.style.display = '';
}

/**
 * Back to the docs hub. The view switches synchronously; the pending edit is
 * flushed in the background (it captures the document id before we clear it).
 */
function closeEditor(): Promise<void> {
  const pendingSave = flushCurrentDocument();
  activeDocumentId = null;
  hideEditor();
  showDocList();
  return pendingSave.then(() => renderDocLists());
}

// ── Document selection ───────────────────────────────────────────
export async function selectDocument(id: string) {
  if (activeDocumentId && activeDocumentId !== id) await flushCurrentDocument();
  activeDocumentId = id;
  ignoredDocumentWords.clear();

  try {
    const doc = await getDocument(id);
    if (doc && !doc.inTrash) {
      showEditor();
      const titleEl = document.getElementById('editor-title') as HTMLInputElement;
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      if (titleEl) titleEl.value = doc.title;
      if (textarea) textarea.value = doc.content;
      updateWordCount(doc.content);
      updateScorePill(doc.content);
      // A new document carries no verdict, and no undo history from the last.
      activeSuggestions = [];
      undoStack = [];
      checkedHash = null;
      droppedCount = 0;
      incompleteHint = null;
      workspaceContinuation = null;
      lastCheck = null;
      checkerError = null;
      renderSuggestions();
      runChecker();
    } else {
      hideEditor();
    }
  } catch (e) { console.error('selectDocument failed:', e); }

  await renderDocLists();
}

// ── Trash operations ─────────────────────────────────────────────
async function trashDoc(id: string) {
  try {
    await moveToTrash(id);
    if (activeDocumentId === id) {
      activeDocumentId = null;
      hideEditor();
    }
  } catch (e) { console.error(e); }
  await renderDocLists();
}

async function restoreDoc(id: string) {
  try {
    await restoreFromTrash(id);
    await selectDocument(id);
  } catch (e) { console.error(e); }
}

async function permanentlyDeleteDoc(id: string) {
  try { await deleteDocumentPermanently(id); } catch (e) { console.error(e); }
  await renderDocLists();
}

async function emptyTrash() {
  try {
    const metadata = await getDocumentsMetadata();
    for (const doc of metadata.filter((m) => m.inTrash)) {
      await deleteDocumentPermanently(doc.id);
    }
  } catch (e) { console.error(e); }
  await renderDocLists();
}

// ── Render doc lists ─────────────────────────────────────────────
export async function renderDocLists() {
  const docListEl   = document.getElementById('document-list');
  const trashListEl = document.getElementById('trash-list');
  const docsEmptyEl = document.getElementById('docs-empty');
  const trashEmptyEl = document.getElementById('trash-empty');
  const searchInput = document.getElementById('search-docs') as HTMLInputElement;
  const query = searchInput?.value.toLowerCase() || '';

  if (docListEl) docListEl.innerHTML = '';
  if (trashListEl) trashListEl.innerHTML = '';

  try {
    const metadata = await getDocumentsMetadata();
    let activeDocs = metadata.filter((m) => !m.inTrash);
    let trashDocs  = metadata.filter((m) => m.inTrash);
    if (query) activeDocs = activeDocs.filter((d) => d.title.toLowerCase().includes(query));

    // Active docs
    if (activeDocs.length === 0) {
      if (docsEmptyEl && docListEl?.style.display !== 'none') docsEmptyEl.style.display = 'flex';
    } else {
      if (docsEmptyEl) docsEmptyEl.style.display = 'none';
      activeDocs.forEach((doc) => {
        const item = document.createElement('div');
        item.className = `doc-item ${doc.id === activeDocumentId ? 'doc-card active' : 'doc-card'}`;
        item.setAttribute('role', 'listitem');
        const updated = new Date(doc.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        item.innerHTML = `
          <div class="doc-card-actions">
            <button class="btn-card-trash btn-trash-doc" title="Move to trash" aria-label="Move '${esc(doc.title)}' to trash">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 5h8l-.7 8H4.7L4 5zm2-2h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
          <div class="doc-title doc-card-title">${esc(doc.title)}</div>
          <div class="doc-snippet doc-card-snippet">${esc(doc.snippet || '')}</div>
          <div class="doc-card-meta">Edited ${updated}</div>`;
        item.querySelector('.doc-title')?.addEventListener('click', () => void selectDocument(doc.id));
        item.querySelector('.doc-snippet')?.addEventListener('click', () => void selectDocument(doc.id));
        item.querySelector('.doc-card-meta')?.addEventListener('click', () => void selectDocument(doc.id));
        item.querySelector('.btn-trash-doc')?.addEventListener('click', (e) => {
          e.stopPropagation();
          void trashDoc(doc.id);
        });
        docListEl?.appendChild(item);
      });
    }

    // Trash docs
    if (trashDocs.length === 0) {
      if (trashEmptyEl && trashListEl?.style.display !== 'none') trashEmptyEl.style.display = 'flex';
    } else {
      if (trashEmptyEl) trashEmptyEl.style.display = 'none';
      trashDocs.forEach((doc) => {
        const item = document.createElement('div');
        item.className = 'trash-item trash-card';
        item.setAttribute('role', 'listitem');
        item.innerHTML = `
          <span class="doc-title trash-card-title">${esc(doc.title)}</span>
          <div class="trash-card-actions">
            <button class="btn-restore-doc btn-restore">Restore</button>
            <button class="btn-perm-delete-doc btn-perm-delete">Delete forever</button>
          </div>`;
        item.querySelector('.btn-restore-doc')?.addEventListener('click', () => void restoreDoc(doc.id));
        item.querySelector('.btn-perm-delete-doc')?.addEventListener('click', () => void permanentlyDeleteDoc(doc.id));
        trashListEl?.appendChild(item);
      });
    }
  } catch (e) { console.error('renderDocLists failed:', e); }
}

// ── Settings ─────────────────────────────────────────────────────
function settingsEls() {
  return {
    kindEl:     document.getElementById('settings-provider-kind') as HTMLSelectElement | null,
    modelEl:    document.getElementById('settings-provider-model') as HTMLInputElement | null,
    strictEl:   document.getElementById('settings-strictness') as HTMLSelectElement | null,
    spellingEl: document.getElementById('settings-categories-spelling') as HTMLInputElement | null,
    grammarEl:  document.getElementById('settings-categories-grammar') as HTMLInputElement | null,
    punctEl:    document.getElementById('settings-categories-punctuation') as HTMLInputElement | null,
    styleEl:    document.getElementById('settings-categories-style') as HTMLInputElement | null,
    keyField:   document.getElementById('settings-api-key-field') as HTMLElement | null,
    keyInput:   document.getElementById('settings-api-key') as HTMLInputElement | null,
    removeKey:  document.getElementById('settings-remove-key') as HTMLButtonElement | null,
    keyHelp:    document.getElementById('settings-key-help') as HTMLElement | null,
    keyHelpLink: document.getElementById('settings-key-help-link') as HTMLAnchorElement | null,
    cloudNotice: document.getElementById('settings-cloud-notice') as HTMLElement | null,
    statusEl:   document.getElementById('settings-status') as HTMLElement | null,
  };
}

function selectedSettingsKind(): ProviderKind {
  const value = settingsEls().kindEl?.value as ProviderKind | undefined;
  return value && PROVIDER_KINDS.includes(value) ? value : 'ollama';
}

async function updateProviderUi(): Promise<void> {
  const { keyField, keyInput, removeKey, keyHelp, keyHelpLink, cloudNotice } = settingsEls();
  const kind = selectedSettingsKind();
  if (keyField) keyField.hidden = kind === 'ollama';
  if (cloudNotice) {
    try {
      const settings = await loadSettings();
      const baseUrl = kind === settings.provider.kind
        ? settings.provider.baseUrl
        : DEFAULT_BASE_URLS[kind];
      cloudNotice.hidden = !providerUsesRemoteEndpoint(kind, baseUrl);
    } catch {
      cloudNotice.hidden = false;
    }
  }
  if (keyHelp && keyHelpLink) {
    const helpUrl = KEY_HELP_URLS[kind];
    if (helpUrl) {
      keyHelpLink.href = helpUrl;
      keyHelpLink.textContent = `Create a free ${PROVIDER_LABELS[kind]} key ↗`;
      keyHelp.hidden = false;
    } else {
      keyHelp.hidden = true;
    }
  }
  try {
    const saved = await hasSecret(kind);
    if (keyInput) keyInput.placeholder = saved ? 'Saved — leave blank to keep it' : 'Paste your key';
    if (removeKey) removeKey.hidden = !saved;
  } catch { /* storage unavailable */ }
}

function showSettingsStatus(tone: 'ok' | 'error' | 'busy', message: string): void {
  const { statusEl } = settingsEls();
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.setAttribute('data-tone', tone);
}

async function refreshSettingsValues(): Promise<void> {
  try {
    const settings = await loadSettings();
    const { kindEl, modelEl, strictEl, spellingEl, grammarEl, punctEl, styleEl } = settingsEls();
    if (kindEl) kindEl.value = settings.provider.kind;
    if (modelEl) modelEl.value = settings.provider.model;
    if (strictEl) strictEl.value = settings.strictness;
    if (spellingEl) spellingEl.checked = settings.categories.spelling;
    if (grammarEl) grammarEl.checked = settings.categories.grammar;
    if (punctEl) punctEl.checked = settings.categories.punctuation;
    if (styleEl) styleEl.checked = settings.categories.style;
    await updateProviderUi();
  } catch (e) { console.error('refreshSettingsValues failed:', e); }
}

/** Saves the settings form (including a pasted API key). Returns success. */
async function persistSettingsForm(): Promise<boolean> {
  try {
    const settings = await loadSettings();
    const { modelEl, strictEl, spellingEl, grammarEl, punctEl, styleEl, keyInput } = settingsEls();
    const kind = selectedSettingsKind();
    const updated: Settings = {
      ...settings,
      provider: {
        kind,
        // A provider switch gets that provider's official address; custom
        // addresses for the same provider are kept (set in options).
        baseUrl: kind === settings.provider.kind ? settings.provider.baseUrl : DEFAULT_BASE_URLS[kind],
        model: modelEl?.value.trim() || DEFAULT_MODELS[kind],
      },
      strictness: (strictEl?.value || 'standard') as Settings['strictness'],
      categories: {
        spelling:    !!spellingEl?.checked,
        grammar:     !!grammarEl?.checked,
        punctuation: !!punctEl?.checked,
        style:       !!styleEl?.checked,
      },
    };
    await saveSettings(updated);
    const key = keyInput?.value.trim();
    if (key) {
      await saveSecret(kind, key);
      if (keyInput) keyInput.value = '';
    }
    await updateProviderUi();
    return true;
  } catch (e) {
    console.error(e);
    showSettingsStatus('error', 'Could not save settings.');
    return false;
  }
}

function bindSettingsEvents(): void {
  const { kindEl, modelEl } = settingsEls();

  kindEl?.addEventListener('change', () => {
    const previous = (kindEl.dataset.currentKind || 'ollama') as ProviderKind;
    const kind = selectedSettingsKind();
    // Only replace the model if the user hadn't customised it for the
    // previous provider.
    if (modelEl && (modelEl.value.trim() === '' || modelEl.value.trim() === DEFAULT_MODELS[previous])) {
      modelEl.value = DEFAULT_MODELS[kind];
    }
    kindEl.dataset.currentKind = kind;
    void updateProviderUi();
  });

  document.getElementById('settings-save-btn')?.addEventListener('click', () => {
    void (async () => {
      if (await persistSettingsForm()) showSettingsStatus('ok', 'Saved.');
    })();
  });

  document.getElementById('settings-remove-key')?.addEventListener('click', () => {
    void (async () => {
      try {
        await saveSecret(selectedSettingsKind(), null);
        await updateProviderUi();
        showSettingsStatus('ok', 'API key removed from this device.');
      } catch (e) { console.error(e); }
    })();
  });

  document.getElementById('settings-fetch-models')?.addEventListener('click', () => {
    void (async () => {
      const fetchBtn = document.getElementById('settings-fetch-models') as HTMLButtonElement | null;
      if (fetchBtn) fetchBtn.disabled = true;
      showSettingsStatus('busy', 'Saving and fetching models…');
      if (!(await persistSettingsForm())) {
        if (fetchBtn) fetchBtn.disabled = false;
        return;
      }
      const result = await sendTyped({ t: 'listModels' }).catch(() => ({
        ok: false as const,
        code: 'network' as const,
        hint: 'Could not reach the background service.',
      }));
      if (fetchBtn) fetchBtn.disabled = false;
      const datalist = document.getElementById('settings-model-list') as HTMLDataListElement | null;
      if (!result.ok) {
        showSettingsStatus('error', result.hint);
        return;
      }
      datalist?.replaceChildren(
        ...result.models.map((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          return opt;
        }),
      );
      showSettingsStatus(
        'ok',
        result.models.length > 0
          ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} available — start typing in the model box to pick one.`
          : 'The server responded but listed no models.',
      );
    })();
  });

  document.getElementById('settings-test-btn')?.addEventListener('click', () => {
    void (async () => {
      const testBtn = document.getElementById('settings-test-btn') as HTMLButtonElement | null;
      if (testBtn) testBtn.disabled = true;
      // The background tests the SAVED config, so persist the form (including
      // a freshly pasted key) first — otherwise we'd test the old provider.
      showSettingsStatus('busy', 'Saving and testing…');
      if (!(await persistSettingsForm())) {
        if (testBtn) testBtn.disabled = false;
        return;
      }
      const result = await sendTyped({ t: 'testConnection' }).catch(() => ({
        ok: false as const,
        code: 'network' as const,
        hint: 'Could not reach the background service.',
      }));
      if (testBtn) testBtn.disabled = false;
      if (result.ok) showSettingsStatus('ok', 'Connected and ready.');
      else showSettingsStatus('error', result.hint);
    })();
  });
}

// ── Storage & folder sync ────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showSyncStatus(tone: 'ok' | 'error' | 'busy', message: string) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.textContent = message;
  el.setAttribute('data-tone', tone);
}

async function refreshStorageUi(promptForPermission = false): Promise<void> {
  const usageEl = document.getElementById('storage-usage');
  if (usageEl) {
    const { bytes } = await getStorageUsage();
    const count = (await getDocumentsMetadata().catch(() => [])).filter((m) => !m.inTrash).length;
    usageEl.textContent = `${count} document${count === 1 ? '' : 's'} · ${formatBytes(bytes)} used in this browser`;
  }

  const stateEl = document.getElementById('sync-folder-state');
  const chooseBtn = document.getElementById('btn-choose-folder') as HTMLButtonElement | null;
  const syncBtn = document.getElementById('btn-sync-now') as HTMLButtonElement | null;
  const forgetBtn = document.getElementById('btn-forget-folder') as HTMLButtonElement | null;

  if (!isFolderSyncSupported()) {
    if (stateEl) stateEl.textContent = 'This browser cannot write to folders. Use Export instead.';
    if (chooseBtn) chooseBtn.hidden = true;
    return;
  }

  const handle = await getSyncFolder(promptForPermission);
  if (handle) {
    if (stateEl) stateEl.textContent = `Saving copies to “${handle.name}”.`;
    if (chooseBtn) chooseBtn.textContent = 'Change folder';
    if (syncBtn) syncBtn.hidden = false;
    if (forgetBtn) forgetBtn.hidden = false;
  } else {
    if (stateEl) {
      stateEl.textContent = 'No folder chosen. Documents stay in this browser profile only.';
    }
    if (chooseBtn) chooseBtn.textContent = 'Choose folder';
    if (syncBtn) syncBtn.hidden = true;
    if (forgetBtn) forgetBtn.hidden = true;
  }
}

async function runFolderSync(): Promise<void> {
  // Called from a click, so re-prompting for permission is allowed here.
  const handle = await getSyncFolder(true);
  if (!handle) {
    showSyncStatus('error', 'Inkwell no longer has permission for that folder. Choose it again.');
    await refreshStorageUi();
    return;
  }
  showSyncStatus('busy', 'Saving copies…');
  const metadata = (await getDocumentsMetadata()).filter((m) => !m.inTrash);
  const docs: SyncableDoc[] = [];
  for (const meta of metadata) {
    const doc = await getDocument(meta.id);
    if (doc) docs.push({ id: doc.id, title: doc.title, content: doc.content });
  }
  const result = await syncDocumentsToFolder(handle, docs, (done, total) =>
    showSyncStatus('busy', `Saving copies… ${done} of ${total}`),
  );
  showSyncStatus(
    result.failed > 0 ? 'error' : 'ok',
    result.failed > 0
      ? `Saved ${result.written}, but ${result.failed} could not be written.`
      : `Saved ${result.written} document${result.written === 1 ? '' : 's'} to “${handle.name}”.`,
  );
}

function bindStorageEvents(): void {
  document.getElementById('btn-choose-folder')?.addEventListener('click', () => {
    void (async () => {
      const handle = await chooseSyncFolder();
      await refreshStorageUi();
      if (handle) {
        showSyncStatus('ok', `Folder set to “${handle.name}”. Press Save copies now to write them.`);
      }
    })();
  });
  document.getElementById('btn-sync-now')?.addEventListener('click', () => void runFolderSync());
  document.getElementById('btn-forget-folder')?.addEventListener('click', () => {
    void (async () => {
      await forgetSyncFolder();
      await refreshStorageUi();
      showSyncStatus('ok', 'Inkwell will no longer write copies to that folder.');
    })();
  });
}

async function initSettings() {
  await refreshSettingsValues();
  const { kindEl } = settingsEls();
  if (kindEl) kindEl.dataset.currentKind = selectedSettingsKind();
  await refreshStorageUi().catch(() => {});
}

// ── Blotty mascots ───────────────────────────────────────────────
function initBlotty() {
  const sidebarBlotty = document.getElementById('blotty-sidebar');
  if (sidebarBlotty) sidebarBlotty.innerHTML = blottySvg('happy', 32);
  const emptyBlotty = document.getElementById('blotty-empty');
  if (emptyBlotty) emptyBlotty.innerHTML = blottySvg('asleep', 64);
  const happyBlotty = document.getElementById('blotty-happy');
  if (happyBlotty) happyBlotty.innerHTML = blottySvg('happy', 52);
}

// ── Suggestion tabs ──────────────────────────────────────────────
function initSuggestionTabs() {
  document.querySelectorAll('.sugg-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sugg-tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      activeFilter = (tab as HTMLElement).dataset.filter || 'all';
      renderSuggestions();
    });
  });
}

// ── Import ───────────────────────────────────────────────────────
let importing = false;

function showImportStatus(tone: 'busy' | 'ok' | 'error', message: string) {
  const el = document.getElementById('import-status');
  if (!el) return;
  el.textContent = message;
  el.setAttribute('data-tone', tone);
  el.hidden = false;
}

function clearImportStatus(afterMs = 0) {
  const el = document.getElementById('import-status');
  if (!el) return;
  if (afterMs > 0) {
    setTrackedTimeout(() => { el.hidden = true; }, afterMs);
  } else {
    el.hidden = true;
  }
}

async function importFiles(files: FileList | File[]) {
  const list = Array.from(files);
  if (list.length === 0 || importing) return;
  importing = true;
  try {
    let lastId: string | null = null;
    for (const file of list) {
      try {
        const result = await importFile(file, (message) => showImportStatus('busy', message));
        const doc = await createDocument(result.title, result.text);
        lastId = doc.id;
        const notice = result.notices.length ? ` ${result.notices.join(' ')}` : '';
        showImportStatus('ok', `Imported “${result.title}”.${notice}`);
      } catch (err) {
        const message = err instanceof ImportError ? err.message : 'Inkwell couldn’t read that file.';
        showImportStatus('error', `${file.name}: ${message}`);
        console.error('Import failed:', err);
      }
    }
    await renderDocLists();
    // Open the last successful import so the check starts straight away.
    if (lastId) {
      await selectDocument(lastId);
      clearImportStatus(6000);
    }
  } finally {
    importing = false;
  }
}

function initImport() {
  const input = document.getElementById('import-file-input') as HTMLInputElement | null;
  const openPicker = () => input?.click();
  document.getElementById('btn-import-doc')?.addEventListener('click', openPicker);
  document.getElementById('btn-import-doc-empty')?.addEventListener('click', openPicker);
  input?.addEventListener('change', () => {
    if (input.files?.length) void importFiles(input.files);
    input.value = ''; // allow re-importing the same file
  });

  // Drag and drop anywhere on the docs hub.
  const hub = document.querySelector<HTMLElement>('.hub-view');
  if (!hub) return;
  const setDragging = (on: boolean) => hub.classList.toggle('drag-over', on);
  let depth = 0;

  hub.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    depth++;
    setDragging(true);
  });
  hub.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  hub.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  });
  hub.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    depth = 0;
    setDragging(false);
    void importFiles(e.dataTransfer.files);
  });
}

// ── New document helper ──────────────────────────────────────────
async function newDocument() {
  try {
    const doc = await createDocument('Untitled Document', '');
    await selectDocument(doc.id);
  } catch (e) { console.error(e); }
}

// ── Main init ────────────────────────────────────────────────────
function initConsentedDashboard() {
  // Reset state
  activeDocumentId = null;
  activeSuggestions = [];
  activeFilter = 'all';
  ignoredDocumentWords.clear();
  latestRunId = null;
  activeRequestIds.clear();
  isChecking = false;
  checkPending = false;
  checkedHash = null;
  droppedCount = 0;
  droppedReasons = [];
  incompleteHint = null;
  lastCheck = null;
  workspaceContinuation = null;
  checkerError = null;
  cooldownUntil = 0;
  if (cooldownRetryTimer) { clearTimeout(cooldownRetryTimer); cooldownRetryTimer = null; }
  try { portClient?.destroy(); } catch { /* */ }
  portClient = null;
  if (autoSaveTimeout) { clearTimeout(autoSaveTimeout); autoSaveTimeout = null; }
  if (checkTimeout) { clearTimeout(checkTimeout); checkTimeout = null; }

  initBlotty();
  void initSettings();
  bindSettingsEvents();
  bindStorageEvents();
  initSuggestionTabs();
  initImport();

  // Start in docs view, editor hidden
  showDocList();
  hideEditor();

  // Nav — any sidebar destination closes the editor workspace first. View
  // switches are synchronous; saving finishes in the background.
  document.getElementById('nav-active-docs')?.addEventListener('click', () => {
    void closeEditor();
  });
  document.getElementById('nav-trash')?.addEventListener('click', () => {
    const pendingSave = flushCurrentDocument();
    activeDocumentId = null;
    hideEditor();
    showTrashList();
    void pendingSave.then(() => renderDocLists());
  });
  document.getElementById('nav-settings')?.addEventListener('click', () => {
    void flushCurrentDocument();
    activeDocumentId = null;
    hideEditor();
    showSettings();
  });

  // Back to docs from the editor workspace
  document.getElementById('btn-back-to-docs')?.addEventListener('click', () => void closeEditor());

  // Export menu
  const exportBtn = document.getElementById('btn-export');
  const exportMenu = document.getElementById('export-menu');
  const closeExportMenu = () => {
    if (exportMenu) exportMenu.hidden = true;
    exportBtn?.setAttribute('aria-expanded', 'false');
  };
  exportBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!exportMenu) return;
    exportMenu.hidden = !exportMenu.hidden;
    exportBtn.setAttribute('aria-expanded', String(!exportMenu.hidden));
  });
  document.addEventListener('click', closeExportMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeExportMenu();
  });
  exportMenu?.addEventListener('click', (e) => {
    const option = (e.target as HTMLElement).closest<HTMLElement>('.export-option');
    if (!option) return;
    e.stopPropagation();
    closeExportMenu();
    const format = option.dataset.format as ExportFormat;
    const title = (document.getElementById('editor-title') as HTMLInputElement)?.value.trim() || 'Untitled document';
    const text = (document.getElementById('editor-textarea') as HTMLTextAreaElement)?.value ?? '';
    const ok = exportDocument(format, title, text);
    if (!ok) {
      showImportStatus('error', 'Your browser blocked the print window. Allow pop-ups for Inkwell and try again.');
    }
  });

  document.getElementById('btn-fix-all')?.addEventListener('click', () => fixAllSuggestions());
  document.getElementById('btn-undo')?.addEventListener('click', () => undoLastFix());

  // Force a check without waiting for the typing pause
  document.getElementById('btn-check-now')?.addEventListener('click', () => {
    if (checkTimeout) { clearTimeout(checkTimeout); checkTimeout = null; }
    forceCheckerFromCurrentProgress();
  });
  document.getElementById('btn-open-settings')?.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  // New doc buttons
  ['btn-new-doc', 'btn-new-doc-hub', 'btn-new-doc-empty'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', () => void newDocument());
  });

  // Empty trash
  document.getElementById('btn-empty-trash')?.addEventListener('click', () => void emptyTrash());

  // Search
  document.getElementById('search-docs')?.addEventListener('input', () => void renderDocLists());

  // Editor: title
  document.getElementById('editor-title')?.addEventListener('input', () => triggerAutoSave());

  // Editor: textarea
  const textareaEl = document.getElementById('editor-textarea');
  textareaEl?.addEventListener('input', handleTextareaInput);
  // Keep underlines glued to the text while scrolling/resizing
  textareaEl?.addEventListener('scroll', scheduleUnderlineRepaint);
  window.addEventListener('resize', scheduleUnderlineRepaint);

  // Formatting buttons
  document.getElementById('btn-bold')?.addEventListener('click', () => formatText('**'));
  document.getElementById('btn-italic')?.addEventListener('click', () => formatText('*'));
  document.getElementById('btn-underline')?.addEventListener('click', () => formatText('_'));

  // Delete doc
  document.getElementById('btn-delete-doc')?.addEventListener('click', async () => {
    if (activeDocumentId) await trashDoc(activeDocumentId);
  });

  // Initial render — land on the docs hub; the user picks what to open.
  void renderDocLists();

  // Listen for storage changes from the extension
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes['settings']) void refreshSettingsValues();
      const docChanged = Object.keys(changes).some(
        (k) => k.startsWith('doc_content_') || k === 'inkwell_documents_metadata'
      );
      if (docChanged) void renderDocLists();
    });
  } catch { /* running outside extension context */ }
}

function showConsentGate(message?: string): void {
  const gate = document.getElementById('setup-required');
  const shell = document.getElementById('dashboard-shell');
  const status = document.getElementById('setup-required-status');
  if (gate) gate.hidden = false;
  if (shell) shell.hidden = true;
  if (message && status) status.textContent = message;
  document.getElementById('setup-required-title')?.focus();

  if (consentGateBound) return;
  consentGateBound = true;
  document.getElementById('btn-open-privacy-setup')?.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings || dashboardStarted) return;
      void initDashboard();
    });
  } catch {
    // The setup button still provides a route when storage events are unavailable.
  }
}

/**
 * Reads only the consent-bearing settings record before startup. Document
 * metadata and content stay untouched until the current disclosure is accepted.
 */
export async function initDashboard(): Promise<void> {
  if (dashboardStarted) return;
  let settings: Settings;
  try {
    settings = await loadSettings();
  } catch {
    showConsentGate('Inkwell could not confirm your privacy choice. Open settings and try again.');
    return;
  }
  if (settings.dataConsentVersion < CURRENT_DATA_CONSENT_VERSION) {
    showConsentGate();
    return;
  }

  dashboardStarted = true;
  const gate = document.getElementById('setup-required');
  const shell = document.getElementById('dashboard-shell');
  if (gate) gate.hidden = true;
  if (shell) shell.hidden = false;
  initConsentedDashboard();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { void initDashboard(); });
}
