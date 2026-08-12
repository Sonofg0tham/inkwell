import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from '@playwright/test';
import { existsSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const extensionPath = path.resolve(
  process.env.INKWELL_EXTENSION_PATH?.trim() || '.output/chrome-mv3',
);
const customChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const fixtureModel = 'inkwell-smoke';

function makeTextPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

interface FixtureState {
  chatRequests: number;
}

interface CdpNode {
  backendNodeId: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

function sendJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function startFixtureServer(): Promise<{
  server: Server;
  url: string;
  state: FixtureState;
}> {
  const state: FixtureState = { chatRequests: 0 };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'OPTIONS') {
        sendJson(response, {});
        return;
      }

      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/api/tags') {
        sendJson(response, { models: [{ name: fixtureModel }] });
        return;
      }

      if (requestUrl.pathname === '/api/chat') {
        state.chatRequests += 1;
        const raw = await requestBody(request);
        const parsed = JSON.parse(raw) as { messages?: Array<{ content?: string }> };
        const prompt = parsed.messages?.map((message) => message.content ?? '').join('\n') ?? '';
        const issues = prompt.includes('I will recieve the parcel today. She walk to work every day.')
          ? [
              {
                type: 'spelling',
                original: 'recieve',
                replacement: 'receive',
                explanation: 'Correct the misspelling.',
              },
              {
                type: 'grammar',
                original: 'She walk',
                replacement: 'She walks',
                explanation: 'Subject and verb do not agree.',
              },
            ]
          : prompt.includes('This sentence has an obvious punctuation error! !')
            ? [{
                type: 'punctuation',
                original: '! !',
                replacement: '!',
                explanation: 'Remove the duplicate punctuation.',
              }]
            : prompt.includes('Due to the fact that it was raining, we stayed inside.') &&
                prompt.includes('Also report wordiness')
              ? [{
                  type: 'style',
                  original: 'Due to the fact that it was raining, we stayed inside.',
                  replacement: 'Because it was raining, we stayed inside.',
                  explanation: 'Wordy and can be simplified.',
                }]
              : prompt.includes('She walk home.')
                ? [{
                    type: 'grammar',
                    original: 'She walk',
                    replacement: 'She walks',
                    explanation: 'Subject and verb do not agree.',
                  }]
                : [];
        sendJson(response, {
          message: { role: 'assistant', content: JSON.stringify({ issues }) },
          done: true,
        });
        return;
      }

      if (requestUrl.pathname === '/') {
        const fixturePort = (server.address() as AddressInfo).port;
        const crossOriginFrameUrl = `http://localhost:${fixturePort}/frame`;
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(`<!doctype html>
          <html lang="en-GB">
            <head>
              <meta charset="utf-8">
              <title>Inkwell smoke fixture</title>
              <style>
                input, textarea, [contenteditable] { display: block; width: 360px; margin: 20px; font: 18px sans-serif; }
                textarea { height: 120px; }
                [contenteditable] { min-height: 100px; padding: 8px; border: 1px solid #777; }
                iframe { width: 480px; height: 220px; border: 1px solid #777; }
                #nested-input { display: inline-block; min-width: 120px; min-height: 1em; }
              </style>
            </head>
            <body>
              <label for="subject">Subject</label><input id="subject" type="text">
              <label for="draft">Draft</label><textarea id="draft"></textarea>
              <div id="article-editor" role="textbox" aria-label="Article" contenteditable="true"></div>
              <div id="nested-editor" role="textbox" aria-label="Formatted article" contenteditable="true">
                <p><strong id="format-token">Keep this:</strong> <span id="nested-input"></span></p>
              </div>
              <label for="controlled-draft">Controlled draft</label><textarea id="controlled-draft"></textarea>
              <output id="controlled-state" aria-live="polite"></output>
              <button id="add-dynamic" type="button">Add dynamic editor</button>
              <div id="dynamic-slot"></div>
              <div id="shadow-host"></div>
              <iframe
                id="draft-frame"
                title="Embedded editor"
                srcdoc="<!doctype html><html><body><label for='frame-draft'>Frame draft</label><textarea id='frame-draft' style='width:320px;height:100px;font-size:18px'></textarea></body></html>"
              ></iframe>
              <iframe id="cross-origin-frame" title="Cross-origin editor" src="${crossOriginFrameUrl}"></iframe>
              <script>
                const controlled = document.getElementById('controlled-draft');
                const controlledState = document.getElementById('controlled-state');
                controlled.addEventListener('input', () => {
                  controlledState.textContent = controlled.value;
                  queueMicrotask(() => { controlled.value = controlledState.textContent; });
                });
                document.getElementById('add-dynamic').addEventListener('click', () => {
                  const textarea = document.createElement('textarea');
                  textarea.id = 'dynamic-draft';
                  textarea.setAttribute('aria-label', 'Dynamic draft');
                  document.getElementById('dynamic-slot').replaceChildren(textarea);
                });
                const shadow = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
                const shadowDraft = document.createElement('textarea');
                shadowDraft.id = 'shadow-draft';
                shadowDraft.setAttribute('aria-label', 'Shadow draft');
                shadow.append(shadowDraft);
              </script>
            </body>
          </html>`);
        return;
      }

      if (requestUrl.pathname === '/frame') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(`<!doctype html><html><body>
          <label for="cross-frame-draft">Cross-origin draft</label>
          <textarea id="cross-frame-draft" style="width:320px;height:100px;font-size:18px"></textarea>
        </body></html>`);
        return;
      }

      if (requestUrl.pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }

      sendJson(response, { error: 'Not found' }, 404);
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, { error: String(error) }, 500);
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, state };
}

async function stopFixtureServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function extensionIdentity(context: BrowserContext): Promise<{ id: string; worker: Worker }> {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker');
  return { id: new URL(worker.url()).host, worker };
}

function attribute(node: CdpNode, name: string): string | undefined {
  const attributes = node.attributes ?? [];
  const index = attributes.indexOf(name);
  return index === -1 ? undefined : attributes[index + 1];
}

function findNodeByClass(node: CdpNode, className: string): CdpNode | undefined {
  const classes = attribute(node, 'class')?.split(/\s+/) ?? [];
  if (classes.includes(className)) return node;
  const descendants = [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument ? [node.contentDocument] : []),
  ];
  for (const child of descendants) {
    const found = findNodeByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

async function closedShadowNode(cdp: CDPSession, className: string): Promise<CdpNode | undefined> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  return findNodeByClass(root as unknown as CdpNode, className);
}

async function waitForClosedShadowNode(
  cdp: CDPSession,
  className: string,
): Promise<CdpNode> {
  let node: CdpNode | undefined;
  await expect.poll(async () => {
    node = await closedShadowNode(cdp, className);
    return Boolean(node);
  }, {
    message: `Expected .${className} inside Inkwell's closed shadow root`,
    timeout: 15_000,
  }).toBe(true);
  return node!;
}

async function activeTabBadge(worker: Worker): Promise<string | null> {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return null;
    return chrome.action.getBadgeText({ tabId: tab.id });
  });
}

async function applySuggestionWithKeyboard(
  cdp: CDPSession,
  page: Page,
  worker: Worker,
): Promise<void> {
  const underline = await waitForClosedShadowNode(cdp, 'ink-seg');
  await expect.poll(() => activeTabBadge(worker), { timeout: 15_000 }).toBe('1');
  await cdp.send('DOM.focus', { backendNodeId: underline.backendNodeId });
  await page.keyboard.press('Enter');

  const applyButton = await waitForClosedShadowNode(cdp, 'ink-card-btn-apply');
  await cdp.send('DOM.focus', { backendNodeId: applyButton.backendNodeId });
  await page.keyboard.press('Enter');
}

test('the installed extension checks and fixes common web editor types', async ({}, testInfo) => {
  test.setTimeout(120_000);
  expect(
    existsSync(path.join(extensionPath, 'manifest.json')),
    `The Chrome extension is missing at ${extensionPath}. Build it or set INKWELL_EXTENSION_PATH to an extracted release archive.`,
  ).toBe(true);

  const { server, url: fixtureUrl, state } = await startFixtureServer();
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
      headless: true,
      ...(customChromium ? { executablePath: customChromium } : { channel: 'chromium' }),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const { id, worker } = await extensionIdentity(context);
    expect(id).toMatch(/^[a-p]{32}$/);

    await test.step('fresh install stays off until privacy consent is explicit', async () => {
      const popup = await context!.newPage();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await expect(popup.getByRole('heading', { name: 'Inkwell', level: 1 })).toBeVisible();
      await expect(popup.locator('#issue-line')).toContainText('privacy setup');
      await popup.close();

      const options = await context!.newPage();
      await options.goto(`chrome-extension://${id}/options.html`);
      await expect(options.locator('#data-consent')).not.toBeChecked();
      await options.locator('#base-url').fill(fixtureUrl);
      await options.locator('#model').fill(fixtureModel);
      await options.locator('#data-consent').check();
      await options.getByRole('button', { name: 'Save & test' }).click();
      await expect(options.locator('#save-result')).toContainText('Saved and connected');
      await expect(options.locator('#data-consent')).toBeDisabled();
      await options.close();
      expect(state.chatRequests).toBeGreaterThanOrEqual(1);
    });

    await test.step('workspace loads after consent', async () => {
      const dashboard = await context!.newPage();
      await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
      await expect(dashboard.locator('#hub-heading')).toHaveText('Docs');
      await expect(dashboard.getByRole('button', { name: 'New doc', exact: true }).first()).toBeVisible();
      await dashboard.close();
    });

    await test.step('workspace imports a packaged PDF through the legacy reader bundle', async () => {
      const dashboard = await context!.newPage();
      await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
      await dashboard.locator('#import-file-input').setInputFiles({
        name: 'Browser PDF smoke.pdf',
        mimeType: 'application/pdf',
        buffer: makeTextPdf('PDF import works.'),
      });
      await expect(dashboard.locator('#editor-title')).toHaveValue('Browser PDF smoke');
      await expect(dashboard.locator('#editor-textarea')).toHaveValue('PDF import works.');
      await dashboard.close();
    });

    await test.step('workspace pauses a large local-model check for explicit continuation', async () => {
      const dashboard = await context!.newPage();
      await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
      await dashboard.getByText('Browser PDF smoke', { exact: true }).click();
      await dashboard.locator('#editor-textarea').fill(
        'A useful sentence for a long local document. '.repeat(2500),
      );
      await dashboard.locator('#btn-check-now').click();
      await expect(dashboard.locator('.workspace-check-paused')).toContainText(
        'Checked sections 1 to 60',
      );
      await expect(dashboard.locator('#btn-check-now')).toHaveText('Continue check');
      await dashboard.close();
    });

    await test.step('trusted typing checks flat, rich, controlled, dynamic, shadow and framed editors', async () => {
      const page = await context!.newPage();
      const diagnostics: string[] = [];
      page.on('console', (message) => diagnostics.push(`console ${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => diagnostics.push(`page error: ${error.message}`));
      const cdp = await context!.newCDPSession(page);
      await cdp.send('DOM.enable');
      cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        diagnostics.push(
          `runtime exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
        );
      });
      await cdp.send('Runtime.enable');

      await page.goto(`${fixtureUrl}/`);
      await page.locator('#draft').click();
      await expect(page.locator('inkwell-overlay')).toBeAttached();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(page.locator('#draft')).toHaveValue('She walks home.');
      expect(state.chatRequests, diagnostics.join(' | ')).toBeGreaterThanOrEqual(2);

      await page.locator('#subject').click();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(page.locator('#subject')).toHaveValue('She walks home.');

      const article = page.locator('#article-editor');
      await article.click();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(article).toHaveText('She walks home.');

      const embedded = page.frameLocator('#draft-frame');
      await embedded.locator('#frame-draft').click();
      await expect(embedded.locator('inkwell-overlay')).toBeAttached();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(embedded.locator('#frame-draft')).toHaveValue('She walks home.');

      const crossOrigin = page.frameLocator('#cross-origin-frame');
      await crossOrigin.locator('#cross-frame-draft').click();
      await page.keyboard.type('She walk home.');
      const crossOriginFrame = page.frames().find(
        (frame) => new URL(frame.url()).hostname === 'localhost',
      );
      expect(crossOriginFrame).toBeDefined();
      const crossOriginCdp = await context!.newCDPSession(crossOriginFrame!);
      await crossOriginCdp.send('DOM.enable');
      await applySuggestionWithKeyboard(crossOriginCdp, page, worker);
      await expect(crossOrigin.locator('#cross-frame-draft')).toHaveValue('She walks home.');

      await page.locator('#nested-input').click();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(page.locator('#nested-input')).toHaveText('She walks home.');
      await expect(page.locator('#format-token')).toHaveText('Keep this:');

      await page.locator('#controlled-draft').click();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(page.locator('#controlled-draft')).toHaveValue('She walks home.');
      await expect(page.locator('#controlled-state')).toHaveText('She walks home.');

      await page.locator('#add-dynamic').click();
      await page.locator('#dynamic-draft').click();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(page.locator('#dynamic-draft')).toHaveValue('She walks home.');

      await page.locator('#shadow-host').locator('#shadow-draft').click();
      await page.keyboard.type('She walk home.');
      await applySuggestionWithKeyboard(cdp, page, worker);
      await expect(page.locator('#shadow-host').locator('#shadow-draft')).toHaveValue('She walks home.');

      // Qualification and the first page check reach the fixture. Later
      // identical passages may be served from the extension's verified cache.
      expect(state.chatRequests).toBeGreaterThanOrEqual(2);
      expect(diagnostics).toEqual([]);

      await page.close();
    });

    await test.step('disabling the top site also disables its cross-origin child editor', async () => {
      const topHost = new URL(fixtureUrl).hostname;
      await worker.evaluate(async (host) => {
        const stored = await chrome.storage.local.get('settings');
        const settings = stored.settings as Record<string, unknown>;
        await chrome.storage.local.set({
          settings: { ...settings, disabledSites: [host] },
        });
      }, topHost);

      const page = await context!.newPage();
      await page.goto(`${fixtureUrl}/`);
      const crossOrigin = page.frameLocator('#cross-origin-frame');
      await crossOrigin.locator('#cross-frame-draft').click();
      await page.keyboard.type('She walk home.');
      await page.waitForTimeout(1_200);
      await expect(crossOrigin.locator('inkwell-overlay')).toHaveCount(0);
      await page.close();

      await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get('settings');
        const settings = stored.settings as Record<string, unknown>;
        await chrome.storage.local.set({
          settings: { ...settings, disabledSites: [] },
        });
      });
    });
  } finally {
    await context?.close();
    await stopFixtureServer(server);
  }
});
