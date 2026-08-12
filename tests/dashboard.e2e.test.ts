// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupChromeMock } from './helpers/chrome-mock';
import * as storage from '../lib/storage/documents';
import { CURRENT_DATA_CONSENT_VERSION, DEFAULT_SETTINGS } from '../lib/settings/schema';

const chromeMock = setupChromeMock();

describe('Inkwell E2E & Integration Test Suite', () => {
  beforeEach(async () => {
    // Clear storage and callbacks
    chromeMock.store.clear();
    chromeMock.changeListeners.clear();
    chromeMock.store.set('settings', {
      ...DEFAULT_SETTINGS,
      dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
    });

    // Reset chrome mock runtime connect mocks if any
    vi.clearAllMocks();

    // Clear any pending timeouts from previous tests
    // @ts-ignore
    if (globalThis.__activeTimeouts) {
      // @ts-ignore
      globalThis.__activeTimeouts.forEach(clearTimeout);
      // @ts-ignore
      globalThis.__activeTimeouts = [];
    }

    // Read the actual index.html file in the source directory
    const htmlPath = path.resolve(__dirname, '../entrypoints/dashboard/index.html');
    // Strip the script tag to prevent double evaluation in Happy DOM
    const html = fs.readFileSync(htmlPath, 'utf8').replace(/<script.*<\/script>/g, '');

    // Inject index.html layout directly into the test runner's document body
    document.body.innerHTML = html;

    // Reset module cache so main.ts re-initializes on dynamic import
    vi.resetModules();
    const main = await import('../entrypoints/dashboard/main');
    main.initDashboard();

    // Wait a brief moment for initial render/async operations to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(() => {
    // Clean up timers and restore any spied-upon functions
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // TIER 1: FEATURE COVERAGE
  // =========================================================================

  describe('Tier 1: Feature Coverage', () => {
    // -----------------------------------------------------------------------
    // A. Editor
    // -----------------------------------------------------------------------
    describe('1. Editor Features', () => {
      it('EC-1.1: typing in textarea updates value and text buffer', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        expect(textarea).not.toBeNull();
        textarea.value = 'Hello World';
        textarea.dispatchEvent(new Event('input'));
        expect(textarea.value).toBe('Hello World');
      });

      it('EC-1.2: selecting text and clicking Bold button wraps text in **', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const btnBold = document.getElementById('btn-bold') as HTMLButtonElement;
        textarea.value = 'Hello World';
        textarea.setSelectionRange(6, 11); // "World"
        btnBold.click();
        expect(textarea.value).toBe('Hello **World**');
      });

      it('EC-1.3: selecting text and clicking Italic button wraps text in *', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const btnItalic = document.getElementById('btn-italic') as HTMLButtonElement;
        textarea.value = 'Hello World';
        textarea.setSelectionRange(6, 11); // "World"
        btnItalic.click();
        expect(textarea.value).toBe('Hello *World*');
      });

      it('EC-1.4: selecting text and clicking Underline button wraps text in _', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const btnUnderline = document.getElementById('btn-underline') as HTMLButtonElement;
        textarea.value = 'Hello World';
        textarea.setSelectionRange(6, 11); // "World"
        btnUnderline.click();
        expect(textarea.value).toBe('Hello _World_');
      });

      it('EC-1.5: updates word count dynamically on input', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const wordCount = document.getElementById('word-count') as HTMLDivElement;
        textarea.value = 'One two three four   five.';
        textarea.dispatchEvent(new Event('input'));
        expect(wordCount.textContent).toBe('5 words');
      });
    });

    // -----------------------------------------------------------------------
    // B. Suggestions
    // -----------------------------------------------------------------------
    describe('2. Suggestions Features', () => {
      it('SUG-1.1: clicking Accept replaces original text and focus', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        // wait for simulated checking connection delay
        await new Promise((resolve) => setTimeout(resolve, 1050));

        const acceptBtn = document.querySelector('.btn-accept-suggestion') as HTMLButtonElement;
        expect(acceptBtn).not.toBeNull();
        acceptBtn.click();

        expect(textarea.value).toBe('There was a beachh.');
        expect(document.activeElement).toBe(textarea);
      });

      it('SUG-1.2: clicking Dismiss removes the card without changing text', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const dismissBtn = document.querySelector('.btn-dismiss-suggestion') as HTMLButtonElement;
        expect(dismissBtn).not.toBeNull();
        dismissBtn.click();

        expect(textarea.value).toBe('Their was a beachh.');
        // Expect 1 card remaining out of 2 original ones
        expect(document.querySelectorAll('.suggestion-card').length).toBe(1);
      });

      it('SUG-1.2a: filters punctuation suggestions and exposes their count', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Hello , world.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const punctuationTab = [...document.querySelectorAll<HTMLButtonElement>('.sugg-tab')]
          .find((tab) => tab.dataset.filter === 'punctuation');
        expect(punctuationTab).toBeDefined();
        expect(punctuationTab?.querySelector('.tab-count')?.textContent).toBe('1');

        punctuationTab?.click();

        const visible = [...document.querySelectorAll<HTMLElement>('.suggestion-card')];
        expect(visible).toHaveLength(1);
        expect(visible[0]?.classList.contains('punctuation')).toBe(true);
        expect(punctuationTab?.getAttribute('aria-selected')).toBe('true');
      });

      it('SUG-1.2aa: describes an empty category without claiming all writing is clear', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const punctuationTab = document.querySelector<HTMLButtonElement>(
          '.sugg-tab[data-filter="punctuation"]',
        );
        punctuationTab?.click();

        expect(document.querySelectorAll('.suggestion-card')).toHaveLength(0);
        expect(document.querySelector('.sugg-empty-text')?.textContent).toBe(
          'No punctuation suggestions in this document.',
        );
        expect(document.getElementById('writing-pulse')?.textContent).toContain(
          '2 suggestions to review',
        );
      });

      it('SUG-1.2b: adds a spelling to the personal dictionary and clears every matching card', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was beachh and beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));
        expect(document.querySelectorAll('.suggestion-card.spelling')).toHaveLength(2);

        const add = document.querySelector<HTMLButtonElement>(
          '.suggestion-card.spelling .btn-add-dictionary',
        );
        expect(add).not.toBeNull();
        expect(add?.type).toBe('button');
        add?.click();

        await vi.waitFor(async () => {
          const stored = (await chrome.storage.local.get('settings'))['settings'];
          expect(stored.personalDictionary).toContain('beachh');
        });
        expect(document.querySelectorAll('.suggestion-card.spelling')).toHaveLength(0);
        expect(document.querySelectorAll('.suggestion-card.grammar')).toHaveLength(1);
      });

      it('SUG-1.2c: ignores every matching spelling on later checks without saving it', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was beachh and beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));
        const ignore = document.querySelector<HTMLButtonElement>(
          '.suggestion-card.spelling .btn-ignore-all',
        );
        expect(ignore).not.toBeNull();
        expect(ignore?.type).toBe('button');
        ignore?.click();

        expect(document.querySelectorAll('.suggestion-card.spelling')).toHaveLength(0);
        expect(document.querySelectorAll('.suggestion-card.grammar')).toHaveLength(1);
        const stored = (await chrome.storage.local.get('settings'))['settings'];
        expect(stored.personalDictionary).not.toContain('beachh');

        (document.getElementById('btn-check-now') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(document.querySelectorAll('.suggestion-card.spelling')).toHaveLength(0);
        expect(document.querySelectorAll('.suggestion-card.grammar')).toHaveLength(1);
      });

      it('SUG-1.3: checks if squiggly underlines are rendered in the overlay', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const underlines = document.querySelectorAll('.squiggly-underline');
        expect(underlines.length).toBeGreaterThan(0);
      });

      it('SUG-1.3a: chunks long documents before sending them to the checker', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = `${'A useful sentence for context. '.repeat(45)} Their was a problem.\n\n${'Another sentence for context. '.repeat(45)} The beachh was quiet.`;
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1100));

        const connect = chrome.runtime.connect as unknown as ReturnType<typeof vi.fn>;
        const port = connect.mock.results.at(-1)?.value;
        const checks = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');
        expect(checks.length).toBeGreaterThan(1);
        expect(checks.every((message: { text: string }) => message.text.length <= 1200)).toBe(true);
      });

      it('SUG-1.3b: cancels in-flight document chunks as soon as the text changes', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a problem in this draft.';
        textarea.dispatchEvent(new Event('input'));
        await new Promise((resolve) => setTimeout(resolve, 1001));

        const connect = chrome.runtime.connect as unknown as ReturnType<typeof vi.fn>;
        const port = connect.mock.results.at(-1)?.value;
        textarea.value = 'Their was a different problem in this draft.';
        textarea.dispatchEvent(new Event('input'));

        const cancels = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'cancel');
        expect(cancels).toHaveLength(1);
      });

      it('SUG-1.3c: bounds concurrent chunk requests for very long documents', async () => {
        const connect = chrome.runtime.connect as unknown as ReturnType<typeof vi.fn>;
        const connectImpl = connect.getMockImplementation() as
          | ((options: { name: string }) => { postMessage: ReturnType<typeof vi.fn> })
          | undefined;
        expect(connectImpl).toBeTypeOf('function');
        connect.mockImplementationOnce((options: { name: string }) => {
          const port = connectImpl!(options);
          port.postMessage.mockImplementation(() => undefined);
          return port;
        });
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'A useful sentence for a long document. '.repeat(900);
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const port = connect.mock.results.at(-1)?.value;
        const checks = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');
        expect(checks).toHaveLength(4);
      });

      it('SUG-1.3d: pauses a large remote-provider check until continuation is explicit', async () => {
        chromeMock.store.set('settings', {
          ...DEFAULT_SETTINGS,
          dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
          provider: {
            ...DEFAULT_SETTINGS.provider,
            kind: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4.1-mini',
          },
        });
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'A useful sentence for a long document. '.repeat(900);
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1150));

        const connect = chrome.runtime.connect as unknown as ReturnType<typeof vi.fn>;
        const port = connect.mock.results.at(-1)?.value;
        const checksBeforeContinue = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');
        expect(checksBeforeContinue).toHaveLength(10);
        expect(document.querySelector('.workspace-check-paused')?.textContent).toContain(
          'Checked sections 1 to 10',
        );
        expect(document.getElementById('btn-check-now')?.textContent).toBe('Continue check');

        (document.getElementById('btn-check-now') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 150));

        const checksAfterContinue = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');
        expect(checksAfterContinue).toHaveLength(20);
        expect(document.querySelector('.workspace-check-paused')?.textContent).toContain(
          'Checked sections 1 to 20',
        );
      });

      it('SUG-1.3e: also bounds each local-model batch', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'A useful sentence for a long local document. '.repeat(2500);
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1600));

        const connect = chrome.runtime.connect as unknown as ReturnType<typeof vi.fn>;
        const port = connect.mock.results.at(-1)?.value;
        const checks = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');
        expect(checks).toHaveLength(60);
        expect(document.querySelector('.workspace-check-paused')?.textContent).toContain(
          'Checked sections 1 to 60',
        );
      });

      it('SUG-1.3f: a rate-limit retry resumes the current batch without losing progress', async () => {
        chromeMock.store.set('settings', {
          ...DEFAULT_SETTINGS,
          dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
          provider: {
            ...DEFAULT_SETTINGS.provider,
            kind: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4.1-mini',
          },
        });
        const main = await import('../entrypoints/dashboard/main');
        main.__setRateLimitCooldownForTests(10);
        const paragraphs = Array.from({ length: 25 }, (_, index) => {
          const lead = index === 0 ? 'Their was a problem. ' : `Section ${index + 1}. `;
          const marker = index === 10 ? 'TRIGGER_SINGLE_RATE_LIMIT ' : '';
          return `${lead}${marker}${'Useful context words. '.repeat(50)}`;
        });
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = paragraphs.join('\n\n');
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(document.querySelectorAll('.suggestion-card.grammar')).toHaveLength(1);
        expect(document.querySelector('.workspace-check-paused')?.textContent).toContain(
          'Checked sections 1 to 10',
        );

        (document.getElementById('btn-check-now') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 350));

        const connect = chrome.runtime.connect as unknown as ReturnType<typeof vi.fn>;
        const port = connect.mock.results.at(-1)?.value;
        const checks = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');
        expect(checks.length).toBeGreaterThanOrEqual(20);
        expect(checks.slice(10).every((message: { text: string }) => !message.text.includes('Their was')))
          .toBe(true);
        expect(document.querySelectorAll('.suggestion-card.grammar')).toHaveLength(1);
        expect(document.querySelector('.workspace-check-paused')?.textContent).toContain(
          'Checked sections 1 to 20',
        );
      });

      it('SUG-1.3g: a manual retry cancels the armed automatic continuation', async () => {
        chromeMock.store.set('settings', {
          ...DEFAULT_SETTINGS,
          dataConsentVersion: CURRENT_DATA_CONSENT_VERSION,
          provider: {
            ...DEFAULT_SETTINGS.provider,
            kind: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4.1-mini',
          },
        });
        const main = await import('../entrypoints/dashboard/main');
        main.__setRateLimitCooldownForTests(600);
        const paragraphs = Array.from({ length: 35 }, (_, index) => {
          const marker = index === 10 ? 'TRIGGER_SINGLE_RATE_LIMIT ' : '';
          return `Section ${index + 1}. ${marker}${'Useful context words. '.repeat(50)}`;
        });
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = paragraphs.join('\n\n');
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1200));
        (document.getElementById('btn-check-now') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(document.querySelector('.checker-error')).not.toBeNull();

        (document.getElementById('btn-check-now') as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(document.querySelector('.workspace-check-paused')?.textContent).toContain(
          'Checked sections 1 to 20',
        );
        const connect = chrome.runtime.connect as unknown as ReturnType<typeof vi.fn>;
        const port = connect.mock.results.at(-1)?.value;
        const checksAfterManualRetry = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');

        await new Promise((resolve) => setTimeout(resolve, 650));

        const checksAfterOldTimer = port.postMessage.mock.calls
          .map((call: unknown[]) => call[0])
          .filter((message: { t?: string }) => message.t === 'check');
        expect(checksAfterOldTimer).toHaveLength(checksAfterManualRetry.length);
        expect(document.querySelector('.workspace-check-paused')?.textContent).toContain(
          'Checked sections 1 to 20',
        );
      });

      it('SUG-1.4: displays and updates readability score correctly', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const readability = document.getElementById('readability-score') as HTMLDivElement;

        // Long complex sentence should have lower readability score
        textarea.value = 'Inkwell is a sophisticated software application designed to facilitate grammatical editing of complex literary articles.';
        textarea.dispatchEvent(new Event('input'));

        const initialText = readability.textContent || '';
        const initialScore = parseInt(initialText.replace(/[^0-9]/g, '')) || 0;

        // Simple text should have higher readability score
        textarea.value = 'The dog is big. The cat is small. We like them.';
        textarea.dispatchEvent(new Event('input'));

        const newText = readability.textContent || '';
        const newScore = parseInt(newText.replace(/[^0-9]/g, '')) || 0;

        expect(newScore).toBeGreaterThan(initialScore);
      });

      it('SUG-1.5: clicking a squiggly underline highlights card', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const underline = document.querySelector('.squiggly-underline') as HTMLElement;
        expect(underline).not.toBeNull();
        underline.click();

        const card = document.querySelector('.suggestion-card');
        expect(card?.classList.contains('highlighted')).toBe(true);
      });

      it('SUG-1.6: writing pulse groups the active suggestion count', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const pulse = document.getElementById('writing-pulse');
        expect(pulse?.textContent).toContain('2 suggestions to review');
        expect(pulse?.dataset.state).toBe('review');
      });
    });

    // -----------------------------------------------------------------------
    // C. Dashboard
    // -----------------------------------------------------------------------
    describe('3. Dashboard Features', () => {
      it('DSH-1.1: clicking New Doc adds doc to active documents sidebar', async () => {
        const btnNewDoc = document.getElementById('btn-new-doc') as HTMLButtonElement;
        btnNewDoc.click();
        await new Promise((resolve) => setTimeout(resolve, 10));

        const docItems = document.querySelectorAll('#document-list .doc-item');
        expect(docItems.length).toBe(1);
        expect(docItems[0]!.querySelector('.doc-title')?.textContent).toBe('Untitled Document');
      });

      it('DSH-1.2: clicking sidebar document loads its content in editor', async () => {
        // Create pre-existing document
        await storage.createDocument('Test Doc 1', 'Content of Test Doc 1');

        // Reload list
        const main = await import('../entrypoints/dashboard/main');
        await main.renderDocLists();

        const titleSpan = document.querySelector('#document-list .doc-item .doc-title') as HTMLElement;
        titleSpan.click();
        await new Promise((resolve) => setTimeout(resolve, 10));

        const titleInput = document.getElementById('editor-title') as HTMLInputElement;
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        expect(titleInput.value).toBe('Test Doc 1');
        expect(textarea.value).toBe('Content of Test Doc 1');
      });

      it('DSH-1.3: search bar filters documents by title keyword', async () => {
        await storage.createDocument('Apple Pie Recipe', 'Content 1');
        await storage.createDocument('Banana Bread Recipe', 'Content 2');

        const main = await import('../entrypoints/dashboard/main');
        await main.renderDocLists();

        const searchInput = document.getElementById('search-docs') as HTMLInputElement;
        searchInput.value = 'Apple';
        searchInput.dispatchEvent(new Event('input'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        const docItems = document.querySelectorAll('#document-list .doc-item');
        expect(docItems.length).toBe(1);
        expect(docItems[0]!.querySelector('.doc-title')?.textContent).toBe('Apple Pie Recipe');
      });

      it('DSH-1.4: deleting a document moves it to trash view', async () => {
        const doc = await storage.createDocument('Trash Target', 'Some content');

        const main = await import('../entrypoints/dashboard/main');
        await main.selectDocument(doc.id);

        const btnDelete = document.getElementById('btn-delete-doc') as HTMLButtonElement;
        btnDelete.click();
        await new Promise((resolve) => setTimeout(resolve, 20));

        // Active list should be empty
        expect(document.querySelectorAll('#document-list .doc-item').length).toBe(0);

        // Switch to Trash View
        const navTrash = document.getElementById('nav-trash') as HTMLButtonElement;
        navTrash.click();
        await new Promise((resolve) => setTimeout(resolve, 10));

        const trashItems = document.querySelectorAll('#trash-list .trash-item');
        expect(trashItems.length).toBe(1);
        expect(trashItems[0]!.querySelector('.doc-title')?.textContent).toBe('Trash Target');
      });

      it('DSH-1.5: navigation tab clicks toggle view visibility', () => {
        const navActive = document.getElementById('nav-active-docs') as HTMLButtonElement;
        const navTrash = document.getElementById('nav-trash') as HTMLButtonElement;
        const navSettings = document.getElementById('nav-settings') as HTMLButtonElement;

        const docList = document.getElementById('document-list') as HTMLDivElement;
        const trashList = document.getElementById('trash-list') as HTMLDivElement;
        const settingsView = document.getElementById('settings-view') as HTMLDivElement;
        const recentHeading = document.querySelector('.document-index-heading') as HTMLDivElement;

        navTrash.click();
        expect(docList.style.display).toBe('none');
        expect(trashList.style.display).toBe('block');
        expect(settingsView.style.display).toBe('none');
        expect(recentHeading.style.display).toBe('none');

        navSettings.click();
        expect(docList.style.display).toBe('none');
        expect(trashList.style.display).toBe('none');
        expect(settingsView.style.display).toBe('block');

        navActive.click();
        expect(docList.style.display).toBe('block');
        expect(trashList.style.display).toBe('none');
        expect(settingsView.style.display).toBe('none');
        expect(recentHeading.style.display).toBe('block');
      });

      it('DSH-1.6: workspace settings opens the extension options page', () => {
        const navSettings = document.getElementById('nav-settings') as HTMLButtonElement;
        navSettings.click();

        const openSettings = document.getElementById('btn-open-settings') as HTMLButtonElement | null;
        expect(openSettings).not.toBeNull();

        openSettings?.click();

        expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
      });

      it('DSH-1.7: renders an editorial writing canvas and labelled suggestion region', () => {
        expect(document.querySelector('.writing-canvas')).not.toBeNull();
        expect(document.getElementById('suggestions-panel')?.getAttribute('aria-label'))
          .toBe('Editorial suggestions');
      });

      it('DSH-1.8: gives the document index private-workspace context', () => {
        expect(document.getElementById('recent-writing-heading')?.textContent).toBe('Recent writing');
      });
    });

    // -----------------------------------------------------------------------
    // D. Storage
    // -----------------------------------------------------------------------
    describe('4. Storage Features', () => {
      it('STR-1.1: Document CRUD operations correctly call chrome.storage.local', async () => {
        const created = await storage.createDocument('Title', 'Content');
        expect(chrome.storage.local.set).toHaveBeenCalled();

        const fetched = await storage.getDocument(created.id);
        expect(fetched?.title).toBe('Title');

        const updated = await storage.updateDocument(created.id, { title: 'New Title' });
        expect(updated.title).toBe('New Title');

        await storage.deleteDocumentPermanently(created.id);
        const deleted = await storage.getDocument(created.id);
        expect(deleted).toBeNull();
      });

      it('STR-1.2: auto-save triggers chrome.storage.local.set after debounced threshold', async () => {
        const doc = await storage.createDocument('AutoSave test', 'Original');
        const main = await import('../entrypoints/dashboard/main');
        await main.selectDocument(doc.id);

        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Updated Text';
        textarea.dispatchEvent(new Event('input'));

        // Verify it's not saved immediately (debounced)
        let current = await storage.getDocument(doc.id);
        expect(current?.content).toBe('Original');

        // Wait for debounce (500ms)
        await new Promise((resolve) => setTimeout(resolve, 550));

        current = await storage.getDocument(doc.id);
        expect(current?.content).toBe('Updated Text');
      });

      it('STR-1.3: offline updates handle errors gracefully', async () => {
        const doc = await storage.createDocument('Offline test', 'Original');
        const main = await import('../entrypoints/dashboard/main');
        await main.selectDocument(doc.id);

        // Spy and force storage write failure
        const setSpy = vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(new Error('Quota exceeded or connection error'));

        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Failed Save attempt';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 550));
        // Verify editor does not crash and handles the error gracefully
        expect(textarea.value).toBe('Failed Save attempt');

        setSpy.mockRestore();
      });

      it('STR-1.4: page reload preserves doc trash status', async () => {
        const doc = await storage.createDocument('Target', 'text');
        await storage.moveToTrash(doc.id);

        // Reload lists simulated by calling renderDocLists
        const main = await import('../entrypoints/dashboard/main');
        await main.renderDocLists();

        const metadata = await storage.getDocumentsMetadata();
        const found = metadata.find((m) => m.id === doc.id);
        expect(found?.inTrash).toBe(true);
      });

      it('STR-1.5: settings modifications are written to local storage', async () => {
        const kindSelect = document.getElementById('settings-provider-kind') as HTMLSelectElement;
        const modelInput = document.getElementById('settings-provider-model') as HTMLInputElement;
        const saveBtn = document.getElementById('settings-save-btn') as HTMLButtonElement;

        kindSelect.value = 'openai';
        modelInput.value = 'gpt-4o';
        saveBtn.click();

        await new Promise((resolve) => setTimeout(resolve, 50));

        const saved = (await chrome.storage.local.get('settings'))['settings'];
        expect(saved).toBeDefined();
        expect(saved.provider.kind).toBe('openai');
        expect(saved.provider.model).toBe('gpt-4o');
      });
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & CORNER CASES
  // =========================================================================

  describe('Tier 2: Boundary & Corner Cases', () => {
    // -----------------------------------------------------------------------
    // A. Editor
    // -----------------------------------------------------------------------
    describe('1. Editor Boundaries', () => {
      it('EC-2.1: handles high word count without throwing and measures word count', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const wordCount = document.getElementById('word-count') as HTMLDivElement;

        const words = new Array(5000).fill('word').join(' ');
        textarea.value = words;
        textarea.dispatchEvent(new Event('input'));

        expect(wordCount.textContent).toBe('5000 words');
      });

      it('EC-2.2: handles emojis and RTL scripts correctly', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const wordCount = document.getElementById('word-count') as HTMLDivElement;

        textarea.value = '👋 Hello context.  שלום עולם! 😊';
        textarea.dispatchEvent(new Event('input'));

        expect(wordCount.textContent).toBe('6 words');
      });

      it('EC-2.3: inserts formatting markers with correct cursor alignment when selection is collapsed', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const btnBold = document.getElementById('btn-bold') as HTMLButtonElement;

        textarea.value = 'Hello World';
        textarea.setSelectionRange(6, 6); // Collapsed cursor before "World"

        btnBold.click();

        expect(textarea.value).toBe('Hello ****World');
        // Cursor should be inside the bold stars: Hello **|**World
        expect(textarea.selectionStart).toBe(8);
      });

      it('EC-2.4: resets word count to 0 and suggestions to empty when cleared', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const wordCount = document.getElementById('word-count') as HTMLDivElement;

        textarea.value = 'Some content here';
        textarea.dispatchEvent(new Event('input'));
        expect(wordCount.textContent).toBe('3 words');

        textarea.value = '';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));
        expect(wordCount.textContent).toBe('0 words');
        expect(document.querySelectorAll('.suggestion-card').length).toBe(0);
      });

      it('EC-2.5: multiple rapid formatting commands execute reliably without throwing', () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        const btnBold = document.getElementById('btn-bold') as HTMLButtonElement;
        const btnItalic = document.getElementById('btn-italic') as HTMLButtonElement;

        textarea.value = 'Test';
        textarea.setSelectionRange(0, 4);

        btnBold.click();
        btnItalic.click();

        expect(textarea.value).toBe('***Test***');
      });
    });

    // -----------------------------------------------------------------------
    // B. Suggestions
    // -----------------------------------------------------------------------
    describe('2. Suggestions Boundaries', () => {
      it('SUG-2.1: returns empty suggestions UI list if document has zero issues', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Perfect sentence without any errors.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        expect(document.querySelectorAll('.suggestion-card').length).toBe(0);
        expect(document.querySelectorAll('.squiggly-underline').length).toBe(0);
      });

      it('SUG-2.2: handles multiple suggestions on same input text cleanly', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const cards = document.querySelectorAll('.suggestion-card');
        expect(cards.length).toBe(2);
      });

      it('SUG-2.3: accepts corrections on character edges without offset corruption', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const acceptBtn = document.querySelector('.btn-accept-suggestion') as HTMLButtonElement;
        acceptBtn.click();

        expect(textarea.value).toBe('There was.');
      });

      it('SUG-2.4: displays retry link/button on PortClient connection drop', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;

        // Force connection failure by throwing on connect
        const connectSpy = vi.spyOn(chrome.runtime, 'connect').mockImplementation(() => {
          throw new Error('Connection failed');
        });

        textarea.value = 'Their was.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        const reconnectBtn = document.getElementById('btn-reconnect-port');
        expect(reconnectBtn).not.toBeNull();
        expect(reconnectBtn?.textContent).toBe('Retry');

        // Cleanup
        connectSpy.mockRestore();
      });

      it('SUG-2.5: rejects updates to suggestion ranges if text anchor has changed', async () => {
        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Their was a beachh.';
        textarea.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 1050));

        // Edit text manually before accepting, thus shifting the text
        textarea.value = 'Pre-edit: Their was a beachh.';
        const acceptBtn = document.querySelector('.btn-accept-suggestion') as HTMLButtonElement;
        expect(acceptBtn).not.toBeNull();

        acceptBtn.click();
        expect(textarea.value).toContain('There');
      });
    });

    // -----------------------------------------------------------------------
    // C. Dashboard Boundaries
    // -----------------------------------------------------------------------
    describe('3. Dashboard Boundaries', () => {
      it('DSH-2.1: coexists multiple documents with duplicate titles', async () => {
        const doc1 = await storage.createDocument('Untitled', 'First');
        const doc2 = await storage.createDocument('Untitled', 'Second');

        expect(doc1.id).not.toBe(doc2.id);

        const metadata = await storage.getDocumentsMetadata();
        expect(metadata.filter((m) => m.title === 'Untitled').length).toBe(2);
      });

      it('DSH-2.2: fallbacks empty/whitespace titles to default names', async () => {
        const doc = await storage.createDocument('   ', 'content');
        expect(doc.title).toBe('Untitled Document');
      });

      it('DSH-2.3: escapes regular expression characters in search queries safely', async () => {
        await storage.createDocument('Special $.*+?^ doc', 'content');
        const main = await import('../entrypoints/dashboard/main');
        await main.renderDocLists();

        const searchInput = document.getElementById('search-docs') as HTMLInputElement;
        searchInput.value = '$.*+?^';
        searchInput.dispatchEvent(new Event('input'));

        await new Promise((resolve) => setTimeout(resolve, 10));
        const docItems = document.querySelectorAll('#document-list .doc-item');
        expect(docItems.length).toBe(1);
        expect(docItems[0]!.querySelector('.doc-title')?.textContent).toBe('Special $.*+?^ doc');
      });

      it('DSH-2.4: deletes large collections of documents without UI locks', async () => {
        for (let i = 0; i < 20; i++) {
          await storage.createDocument(`Doc ${i}`, 'Text');
        }

        const main = await import('../entrypoints/dashboard/main');
        await main.renderDocLists();

        // Move all to trash
        const metadata = await storage.getDocumentsMetadata();
        for (const doc of metadata) {
          await storage.moveToTrash(doc.id);
        }

        // Empty trash
        const btnEmptyTrash = document.getElementById('btn-empty-trash') as HTMLButtonElement;
        btnEmptyTrash.click();

        await new Promise((resolve) => setTimeout(resolve, 50));
        const finalMeta = await storage.getDocumentsMetadata();
        expect(finalMeta.length).toBe(0);
      });

      it('DSH-2.5: handles opening invalid/nonexistent ID safely', async () => {
        const main = await import('../entrypoints/dashboard/main');
        await main.selectDocument('nonexistent_id');

        const editorContainer = document.getElementById('editor-container');
        expect(editorContainer?.style.display).toBe('none');
      });
    });

    // -----------------------------------------------------------------------
    // D. Storage Boundaries
    // -----------------------------------------------------------------------
    describe('4. Storage Boundaries', () => {
      it('STR-2.1: displays warnings when quota storage limits are reached', async () => {
        // Create document first when storage.local is healthy
        const doc = await storage.createDocument('Title', 'Content');
        const main = await import('../entrypoints/dashboard/main');
        await main.selectDocument(doc.id);

        // Spy on set and reject
        const setSpy = vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES_EXCEEDED'));

        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Overriding quota';

        // Wait for debounce auto-save trigger
        textarea.dispatchEvent(new Event('input'));
        await new Promise((resolve) => setTimeout(resolve, 550));

        // It should handle the error, keep the app functional, and render a warning badge
        expect(textarea.value).toBe('Overriding quota');
        const warning = document.getElementById('storage-warning');
        expect(warning).not.toBeNull();
        expect(warning?.textContent).toContain('Storage Quota Exceeded');

        setSpy.mockRestore();
      });

      it('STR-2.2: sequences multiple concurrent writes to avoid data races', async () => {
        const doc = await storage.createDocument('Conc test', 'Initial');

        // Rapid updates
        const p1 = storage.updateDocument(doc.id, { content: 'Update 1' });
        const p2 = storage.updateDocument(doc.id, { content: 'Update 2' });
        const p3 = storage.updateDocument(doc.id, { content: 'Update 3' });

        await Promise.all([p1, p2, p3]);

        const finalDoc = await storage.getDocument(doc.id);
        expect(finalDoc?.content).toBe('Update 3');
      });

      it('STR-2.3: parses corrupted/malformed structures safely without crash', async () => {
        // Seed store with malformed values
        await chrome.storage.local.set({ 'doc:corrupt': { id: 'corrupt' } as any });

        const doc = await storage.getDocument('corrupt');
        expect(doc?.title).toBeUndefined(); // Schema parsed it safely as object, did not throw
      });

      it('STR-2.4: schedules deletion ahead of debounced saves to prevent save resurrection', async () => {
        const doc = await storage.createDocument('DeleteAutoSave conflict', 'Initial');
        const main = await import('../entrypoints/dashboard/main');
        await main.selectDocument(doc.id);

        const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
        textarea.value = 'Changes made';
        textarea.dispatchEvent(new Event('input')); // auto-save scheduled

        // Immediately delete document
        const btnDelete = document.getElementById('btn-delete-doc') as HTMLButtonElement;
        btnDelete.click();

        await new Promise((resolve) => setTimeout(resolve, 550));

        const metadata = await storage.getDocumentsMetadata();
        const found = metadata.find((m) => m.id === doc.id);
        expect(found?.inTrash).toBe(true);
      });

      it('STR-2.5: listens to chrome.storage.onChanged to sync updates from popup', async () => {
        const doc = await storage.createDocument('Sync test', 'Original');
        const main = await import('../entrypoints/dashboard/main');
        await main.renderDocLists();

        // Simulate external change by writing directly to storage
        await storage.updateDocument(doc.id, { title: 'Updated Externally' });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const titles = Array.from(document.querySelectorAll('#document-list .doc-item .doc-title')).map(
          (el) => el.textContent
        );
        expect(titles).toContain('Updated Externally');
      });
    });
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE COMBINATIONS
  // =========================================================================

  describe('Tier 3: Cross-Feature Combinations', () => {
    it('COMB-3.1: formats selection while suggestion highlights are active and updates highlights offsets', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));

      await new Promise((resolve) => setTimeout(resolve, 1050));

      const btnBold = document.getElementById('btn-bold') as HTMLButtonElement;
      textarea.setSelectionRange(12, 18); // "beachh"
      btnBold.click();

      expect(textarea.value).toBe('Their was a **beachh**.');

      // Wait 1050ms for the check that formatted text triggers to resolve
      await new Promise((resolve) => setTimeout(resolve, 1050));

      const acceptBtn = document.querySelector('.btn-accept-suggestion') as HTMLButtonElement;
      expect(acceptBtn).not.toBeNull();
    });

    it('COMB-3.2: auto-saves content during input and restores cursor position after reload', async () => {
      const doc = await storage.createDocument('Cursor restore', 'Original');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Cursor is here and typing.';
      textarea.setSelectionRange(10, 10);
      textarea.dispatchEvent(new Event('input'));

      await new Promise((resolve) => setTimeout(resolve, 550));

      const saved = await storage.getDocument(doc.id);
      expect(saved?.content).toBe('Cursor is here and typing.');
      expect(textarea.selectionStart).toBe(10);
    });

    it('COMB-3.3: accepting a suggestion updates editor text and triggers save immediately', async () => {
      const doc = await storage.createDocument('Suggestion save', 'Their was.');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      await new Promise((resolve) => setTimeout(resolve, 1050));

      const acceptBtn = document.querySelector('.btn-accept-suggestion') as HTMLButtonElement;
      expect(acceptBtn).not.toBeNull();
      acceptBtn.click();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const saved = await storage.getDocument(doc.id);
      expect(saved?.content).toBe('There was.');
    });

    it('COMB-3.4: switching active documents flushes previous edits to storage', async () => {
      const doc1 = await storage.createDocument('Doc 1', 'Content 1');
      const doc2 = await storage.createDocument('Doc 2', 'Content 2');

      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc1.id);

      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Modified Content 1';
      textarea.dispatchEvent(new Event('input')); // auto-save scheduled

      await main.selectDocument(doc2.id);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const savedDoc1 = await storage.getDocument(doc1.id);
      expect(savedDoc1?.content).toBe('Modified Content 1');
    });

    it('COMB-3.5: trashing active document opens next active or displays empty view', async () => {
      const doc1 = await storage.createDocument('Doc 1', 'Content 1');
      const doc2 = await storage.createDocument('Doc 2', 'Content 2');

      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc1.id);

      const btnDelete = document.getElementById('btn-delete-doc') as HTMLButtonElement;
      btnDelete.click();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const editorContainer = document.getElementById('editor-container');
      expect(editorContainer?.style.display).toBe('none');
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS
  // =========================================================================

  describe('Tier 4: Real-World Application Scenarios', () => {
    it('T4_SCEN_01: Drafting Lifecycle User Journey (Happy Path)', async () => {
      const btnNewDoc = document.getElementById('btn-new-doc') as HTMLButtonElement;
      btnNewDoc.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const titleInput = document.getElementById('editor-title') as HTMLInputElement;
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;

      titleInput.value = 'My Story';
      titleInput.dispatchEvent(new Event('input'));

      textarea.value = 'Their was a strong wind.';
      textarea.dispatchEvent(new Event('input'));

      await new Promise((resolve) => setTimeout(resolve, 1050));

      const wordCount = document.getElementById('word-count') as HTMLDivElement;
      expect(wordCount.textContent).toBe('5 words');

      const card = document.querySelector('.suggestion-card');
      expect(card).not.toBeNull();
      expect(card?.querySelector('.suggestion-original')?.textContent).toContain('Their');

      const acceptBtn = card?.querySelector('.btn-accept-suggestion') as HTMLButtonElement;
      acceptBtn.click();

      expect(textarea.value).toBe('There was a strong wind.');
      const readability = document.getElementById('readability-score') as HTMLDivElement;
      expect(readability.textContent).toContain('Readability:');
    });

    it('T4_SCEN_02: Offline working, buffer changes, and reconnect sync', async () => {
      const doc = await storage.createDocument('Offline Sync Journey', 'Original text');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;

      // 1. Simulates connection loss by rejecting storage writes
      const mockSet = vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(new Error('Network disconnected'));

      textarea.value = 'Offline written text';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 550));

      expect(textarea.value).toBe('Offline written text');

      // 2. Restore connection
      mockSet.mockRestore();

      // 3. Type more and verify it syncs to local storage
      textarea.value = 'Offline written text now synced!';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 550));

      const saved = await storage.getDocument(doc.id);
      expect(saved?.content).toBe('Offline written text now synced!');
    });

    it('T4_SCEN_03: Document Management & Housekeeping User Journey', async () => {
      await storage.createDocument('Apples', 'Apples draft');
      await storage.createDocument('Bananas', 'Bananas draft');
      const targetDoc = await storage.createDocument('Cherry Pie Recipe', 'Cherry draft');

      const main = await import('../entrypoints/dashboard/main');
      await main.renderDocLists();

      const searchInput = document.getElementById('search-docs') as HTMLInputElement;
      searchInput.value = 'Cherry';
      searchInput.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const docItems = document.querySelectorAll('#document-list .doc-item');
      expect(docItems.length).toBe(1);

      const btnTrash = docItems[0]!.querySelector('.btn-trash-doc') as HTMLButtonElement;
      btnTrash.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));

      const navTrash = document.getElementById('nav-trash') as HTMLButtonElement;
      navTrash.click();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const restoreBtn = document.querySelector('#trash-list .trash-item .btn-restore-doc') as HTMLButtonElement;
      expect(restoreBtn).not.toBeNull();
      restoreBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const navActive = document.getElementById('nav-active-docs') as HTMLButtonElement;
      navActive.click();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const finalDocs = Array.from(document.querySelectorAll('#document-list .doc-item .doc-title')).map(
        (el) => el.textContent
      );
      expect(finalDocs).toContain('Cherry Pie Recipe');
    });

    it('T4_SCEN_04: Configuration & Provider settings updates settings in database', async () => {
      const navSettings = document.getElementById('nav-settings') as HTMLButtonElement;
      navSettings.click();

      const kindSelect = document.getElementById('settings-provider-kind') as HTMLSelectElement;
      const modelInput = document.getElementById('settings-provider-model') as HTMLInputElement;
      const saveBtn = document.getElementById('settings-save-btn') as HTMLButtonElement;

      kindSelect.value = 'anthropic';
      modelInput.value = 'claude-3-5-sonnet';
      saveBtn.click();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const settings = (await chrome.storage.local.get('settings'))['settings'];
      expect(settings).toBeDefined();
      expect(settings.provider.kind).toBe('anthropic');
      expect(settings.provider.model).toBe('claude-3-5-sonnet');
    });

    it('T4_SCEN_05: Pasting Large Document & Quality Check Flow', async () => {
      const doc = await storage.createDocument('Big Essay', 'Original content');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;

      const paragraph = 'Pasted paragraph text which is repeated several times to construct a large document testing performance metrics. ';
      textarea.value = new Array(15).fill(paragraph).join('\n');
      textarea.dispatchEvent(new Event('input'));

      const wordCount = document.getElementById('word-count') as HTMLDivElement;
      expect(parseInt(wordCount.textContent || '')).toBe(240);

      const readability = document.getElementById('readability-score') as HTMLDivElement;
      expect(readability.textContent).toContain('Readability:');
    });
  });

  // =========================================================================
  // TIER 5: EDITOR WORKSPACE VIEW SWITCHING (docs hub ↔ editor)
  // =========================================================================

  describe('Tier 5: Editor workspace view switching', () => {
    function hubView(): HTMLElement {
      return document.querySelector('.hub-view') as HTMLElement;
    }
    function editorContainer(): HTMLElement {
      return document.getElementById('editor-container') as HTMLElement;
    }

    it('VS-1: selecting a document opens the editor and hides the docs hub', async () => {
      const doc = await storage.createDocument('Focus Draft', 'Some words.');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      expect(editorContainer().style.display).toBe('flex');
      expect(hubView().style.display).toBe('none');
    });

    it('VS-2: back button returns to the docs hub and hides the editor', async () => {
      const doc = await storage.createDocument('Focus Draft', 'Some words.');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      const backBtn = document.getElementById('btn-back-to-docs') as HTMLButtonElement;
      expect(backBtn).not.toBeNull();
      backBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(editorContainer().style.display).toBe('none');
      expect(hubView().style.display).not.toBe('none');
      const docList = document.getElementById('document-list') as HTMLElement;
      expect(docList.style.display).toBe('block');
    });

    it('VS-3: creating a new doc goes straight into the editor', async () => {
      const btnNewDoc = document.getElementById('btn-new-doc') as HTMLButtonElement;
      btnNewDoc.click();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(editorContainer().style.display).toBe('flex');
      expect(hubView().style.display).toBe('none');
    });

    it('VS-4: sidebar Docs nav closes the editor and shows the list', async () => {
      const doc = await storage.createDocument('Focus Draft', 'Some words.');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      const navDocs = document.getElementById('nav-active-docs') as HTMLButtonElement;
      navDocs.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(editorContainer().style.display).toBe('none');
      expect(hubView().style.display).not.toBe('none');
    });

    it('CS-1: provider errors surface as an actionable error card, not silence', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'TRIGGER_CHECKER_ERROR some text';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const errorCard = document.querySelector('.checker-error') as HTMLElement;
      expect(errorCard).not.toBeNull();
      expect(errorCard.textContent).toContain('Check your API key');

      const pulse = document.getElementById('writing-pulse') as HTMLElement;
      expect(pulse.dataset.state).toBe('error');

      // Retry action exists and re-triggers a check
      const retryBtn = errorCard.querySelector('.btn-retry-check') as HTMLButtonElement;
      expect(retryBtn).not.toBeNull();
    });

    it('CS-2: a successful check after an error clears the error card', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'TRIGGER_CHECKER_ERROR some text';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(document.querySelector('.checker-error')).not.toBeNull();

      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(document.querySelector('.checker-error')).toBeNull();
      expect(document.querySelectorAll('.suggestion-card').length).toBeGreaterThan(0);
    });

    it('CS-3: document titles render as text, not HTML', async () => {
      await storage.createDocument('<img src=x onerror="window.__xss=1"> Sneaky', 'content');
      const main = await import('../entrypoints/dashboard/main');
      await main.renderDocLists();

      const title = document.querySelector('#document-list .doc-title') as HTMLElement;
      expect(title.textContent).toContain('Sneaky');
      expect(title.querySelector('img')).toBeNull();
    });

    it('DS-1: switching provider kind auto-fills the default model and saves the matching base URL', async () => {
      (document.getElementById('nav-settings') as HTMLButtonElement).click();
      const kindSelect = document.getElementById('settings-provider-kind') as HTMLSelectElement;
      const modelInput = document.getElementById('settings-provider-model') as HTMLInputElement;

      kindSelect.value = 'openrouter';
      kindSelect.dispatchEvent(new Event('change'));
      expect(modelInput.value).toBe('openai/gpt-5-mini');

      (document.getElementById('settings-save-btn') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const settings = (await chrome.storage.local.get('settings'))['settings'];
      expect(settings.provider.kind).toBe('openrouter');
      expect(settings.provider.baseUrl).toBe('https://openrouter.ai/api');
      expect(settings.provider.model).toBe('openai/gpt-5-mini');
    });

    it('DS-2: saving with an API key stores the secret for the selected provider and clears the field', async () => {
      (document.getElementById('nav-settings') as HTMLButtonElement).click();
      const kindSelect = document.getElementById('settings-provider-kind') as HTMLSelectElement;
      kindSelect.value = 'gemini';
      kindSelect.dispatchEvent(new Event('change'));

      const keyInput = document.getElementById('settings-api-key') as HTMLInputElement;
      keyInput.value = 'AIza-test-key';
      (document.getElementById('settings-save-btn') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const secrets = (await chrome.storage.local.get('secrets'))['secrets'];
      expect(secrets.gemini).toBe('AIza-test-key');
      expect(keyInput.value).toBe('');
    });

    it('DS-3: API key field hides for local providers and shows for cloud ones', async () => {
      (document.getElementById('nav-settings') as HTMLButtonElement).click();
      const kindSelect = document.getElementById('settings-provider-kind') as HTMLSelectElement;
      const keyField = document.getElementById('settings-api-key-field') as HTMLElement;

      kindSelect.value = 'ollama';
      kindSelect.dispatchEvent(new Event('change'));
      expect(keyField.hidden).toBe(true);

      kindSelect.value = 'openrouter';
      kindSelect.dispatchEvent(new Event('change'));
      expect(keyField.hidden).toBe(false);
    });

    it('DS-4: Test connection reports the background result', async () => {
      (globalThis.chrome.runtime.sendMessage as any) = vi.fn(async () => ({ ok: true }));
      (document.getElementById('nav-settings') as HTMLButtonElement).click();

      (document.getElementById('settings-test-btn') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const status = document.getElementById('settings-status') as HTMLElement;
      expect(status.textContent).toContain('Connected');
    });

    it('DS-5: Test connection saves the pending form (provider + key) before testing', async () => {
      let settingsAtTestTime: any = null;
      (globalThis.chrome.runtime.sendMessage as any) = vi.fn(async (msg: any) => {
        if (msg?.t === 'testConnection') {
          settingsAtTestTime = (await chrome.storage.local.get('settings'))['settings'];
          return { ok: true };
        }
        return { ok: false };
      });
      (document.getElementById('nav-settings') as HTMLButtonElement).click();

      // User picks OpenRouter and pastes a key, but does NOT press Save…
      const kindSelect = document.getElementById('settings-provider-kind') as HTMLSelectElement;
      kindSelect.value = 'openrouter';
      kindSelect.dispatchEvent(new Event('change'));
      const keyInput = document.getElementById('settings-api-key') as HTMLInputElement;
      keyInput.value = 'sk-or-fresh-key';

      // …then hits Test connection straight away.
      (document.getElementById('settings-test-btn') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The background must have seen the OpenRouter config, not the stale one.
      expect(settingsAtTestTime?.provider?.kind).toBe('openrouter');
      expect(settingsAtTestTime?.provider?.baseUrl).toBe('https://openrouter.ai/api');
      const secrets = (await chrome.storage.local.get('secrets'))['secrets'];
      expect(secrets.openrouter).toBe('sk-or-fresh-key');
      expect(keyInput.value).toBe('');
    });

    it('CS-5: never claims "clear" for text that has not been checked', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      const pulse = document.getElementById('writing-pulse') as HTMLElement;

      // Get to a genuine clear verdict first.
      textarea.value = 'This sentence is completely fine.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(pulse.dataset.state).toBe('clear');

      // Now change the text. The old verdict must not carry over.
      textarea.value = 'This sentence is completely fine. Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      expect(pulse.dataset.state).not.toBe('clear');
      expect(pulse.textContent).toBe('Checking…');
    });

    it('CS-6: reports when the model found issues it could not place in the text', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'TRIGGER_UNPLACEABLE some prose here';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const pulse = document.getElementById('writing-pulse') as HTMLElement;
      expect(pulse.dataset.state).toBe('partial');
      expect(pulse.dataset.state).not.toBe('clear');

      const card = document.querySelector('.checker-partial') as HTMLElement;
      expect(card).not.toBeNull();
      expect(card.textContent).toContain('Couldn’t use 2 suggestions');
    });

    it('CS-6b: keeps local suggestions but marks the contextual check as incomplete', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'teh message TRIGGER_CONTEXT_UNAVAILABLE';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const pulse = document.getElementById('writing-pulse') as HTMLElement;
      expect(pulse.dataset.state).toBe('partial');
      expect(document.querySelectorAll('.suggestion-card')).toHaveLength(1);
      const partial = document.querySelector('.checker-partial') as HTMLElement;
      expect(partial.textContent).toContain('Contextual model unavailable');
    });

    it('CS-7: shows which model produced the current verdict', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const provenance = document.getElementById('check-provenance') as HTMLElement;
      expect(provenance.hidden).toBe(false);
      expect(provenance.textContent).toContain('mock-model');
    });

    it('CS-8: Check now runs a check immediately instead of waiting for the pause', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));

      // Fire straight away, well inside the 1s debounce window.
      (document.getElementById('btn-check-now') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(document.querySelectorAll('.suggestion-card').length).toBeGreaterThan(0);
    });

    it('FA-1: Fix all applies every suggestion in one go', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(document.querySelectorAll('.suggestion-card').length).toBe(2);

      (document.getElementById('btn-fix-all') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(textarea.value).toBe('There was a beach.');
      expect(document.querySelectorAll('.suggestion-card').length).toBe(0);
    });

    it('FA-2: Undo restores the text after Fix all', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      (document.getElementById('btn-fix-all') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(textarea.value).toBe('There was a beach.');

      (document.getElementById('btn-undo') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(textarea.value).toBe('Their was a beachh.');
    });

    it('FA-3: Undo restores the text after a single accepted suggestion', async () => {
      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      (document.querySelector('.btn-accept-suggestion') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(textarea.value).not.toBe('Their was a beachh.');

      (document.getElementById('btn-undo') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(textarea.value).toBe('Their was a beachh.');
    });

    it('FA-4: Undo is disabled until there is something to undo', async () => {
      const undo = document.getElementById('btn-undo') as HTMLButtonElement;
      expect(undo.disabled).toBe(true);

      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      (document.querySelector('.btn-accept-suggestion') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(undo.disabled).toBe(false);
    });

    it('FA-5: Fix all is hidden when there is nothing to fix', async () => {
      const fixAll = document.getElementById('btn-fix-all') as HTMLButtonElement;
      expect(fixAll.hidden).toBe(true);

      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'Their was a beachh.';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(fixAll.hidden).toBe(false);
      expect(fixAll.textContent).toContain('2');
    });

    it('CS-4: a rate-limited check pauses auto-checking, then retries by itself', async () => {
      const main = await import('../entrypoints/dashboard/main');
      main.__setRateLimitCooldownForTests(3000);

      const textarea = document.getElementById('editor-textarea') as HTMLTextAreaElement;
      textarea.value = 'TRIGGER_RATE_LIMIT some text';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Error card shown, and it explains the automatic retry
      const errorCard = document.querySelector('.checker-error') as HTMLElement;
      expect(errorCard).not.toBeNull();
      expect(errorCard.textContent).toContain('Rate limited');

      const port = (globalThis.chrome.runtime.connect as any).mock.results[0].value;
      const checksBefore = port.postMessage.mock.calls.filter((c: any[]) => c[0].t === 'check').length;

      // Typing again during the cooldown must NOT fire another request
      textarea.value = 'TRIGGER_RATE_LIMIT some more text';
      textarea.dispatchEvent(new Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const checksDuring = port.postMessage.mock.calls.filter((c: any[]) => c[0].t === 'check').length;
      expect(checksDuring).toBe(checksBefore);

      // After the cooldown expires, the retry fires on its own
      await new Promise((resolve) => setTimeout(resolve, 2600));
      const checksAfter = port.postMessage.mock.calls.filter((c: any[]) => c[0].t === 'check').length;
      expect(checksAfter).toBeGreaterThan(checksBefore);
    });

    it('DS-6: Fetch models fills the model datalist from the background', async () => {
      (globalThis.chrome.runtime.sendMessage as any) = vi.fn(async (msg: any) => {
        if (msg?.t === 'listModels') return { ok: true, models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'] };
        return { ok: true };
      });
      (document.getElementById('nav-settings') as HTMLButtonElement).click();

      (document.getElementById('settings-fetch-models') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const options = document.querySelectorAll('#settings-model-list option');
      expect(options.length).toBe(2);
      const status = document.getElementById('settings-status') as HTMLElement;
      expect(status.textContent).toContain('2 models');
    });

    it('VS-5: trashing the open doc from the editor returns to the hub', async () => {
      const doc = await storage.createDocument('Doomed Draft', 'Bye.');
      const main = await import('../entrypoints/dashboard/main');
      await main.selectDocument(doc.id);

      const deleteBtn = document.getElementById('btn-delete-doc') as HTMLButtonElement;
      deleteBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(editorContainer().style.display).toBe('none');
      expect(hubView().style.display).not.toBe('none');
    });
  });
});
