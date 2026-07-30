import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assetDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(assetDirectory, '..', '..');
const extensionPath = path.join(repositoryRoot, '.output', 'chrome-mv3');
const customChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const fixtureModel = 'inkwell-store-capture';

function sendJson(response, value, statusCode = 200) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

async function startFixtureServer() {
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
        const raw = await readBody(request);
        const parsed = JSON.parse(raw);
        const prompt = Array.isArray(parsed.messages)
          ? parsed.messages.map((message) => message?.content ?? '').join('\n')
          : '';
        const issues = [];
        if (prompt.includes('recieve')) {
          issues.push({
            type: 'spelling',
            original: 'recieve',
            replacement: 'receive',
            explanation: 'Correct the misspelling.',
          });
        }
        if (prompt.includes('tommorow')) {
          issues.push({
            type: 'spelling',
            original: 'tommorow',
            replacement: 'tomorrow',
            explanation: 'Correct the misspelling.',
          });
        }
        if (prompt.includes('Your welcome')) {
          issues.push({
            type: 'grammar',
            original: 'Your welcome',
            replacement: "You're welcome",
            explanation: "Use the contraction for 'you are'.",
          });
        }
        sendJson(response, {
          message: { role: 'assistant', content: JSON.stringify({ issues }) },
          done: true,
        });
        return;
      }

      sendJson(response, { error: 'Not found' }, 404);
    })().catch((error) => {
      sendJson(response, { error: String(error) }, 500);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function extensionId(context) {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent('serviceworker');
  return new URL(worker.url()).host;
}

async function waitForFonts(page) {
  await page.evaluate(() => document.fonts.ready);
}

async function assertPngDimensions(filename, expectedWidth, expectedHeight) {
  const buffer = await readFile(path.join(assetDirectory, filename));
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error(`${filename} is not a PNG file.`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `${filename} is ${width} x ${height}; expected ${expectedWidth} x ${expectedHeight}.`,
    );
  }
  console.log(`${filename}: ${width} x ${height}`);
}

async function captureProductScreenshots() {
  if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error('Chrome build missing. Run `npm.cmd run build` first.');
  }

  const profile = await mkdtemp(path.join(tmpdir(), 'inkwell-store-assets-'));
  const { server, url: fixtureUrl } = await startFixtureServer();
  let context;

  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      ...(customChromium ? { executablePath: customChromium } : { channel: 'chromium' }),
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });

    const id = await extensionId(context);
    for (const existingPage of context.pages()) await existingPage.close();

    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#privacy-consent-title').waitFor({ state: 'visible' });
    await waitForFonts(options);
    await options.screenshot({
      path: path.join(assetDirectory, 'screenshot-privacy-setup-1280x800.png'),
    });

    await options.locator('#base-url').fill(fixtureUrl);
    await options.locator('#model').fill(fixtureModel);
    await options.locator('#data-consent').check();
    await options.getByRole('button', { name: 'Save & test' }).click();
    await options.locator('#save-result').filter({ hasText: 'Saved and connected' }).waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    await options.locator('input[name="dialect"][value="en-AU"]').check();
    await options.locator('#dictionary-word').fill('Colourise');
    await options.locator('#dictionary-add').click();
    await options.locator('#dictionary-list').filter({ hasText: 'Colourise' }).waitFor();
    const languageHeading = options.getByRole('heading', { name: 'Language & tone' });
    await languageHeading.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await options.evaluate(() => window.scrollBy(0, -24));
    await options.screenshot({
      path: path.join(assetDirectory, 'screenshot-language-dictionary-1280x800.png'),
    });
    await options.setViewportSize({ width: 390, height: 844 });
    await languageHeading.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await options.evaluate(() => window.scrollBy(0, -16));
    const reviewDirectory = path.join(repositoryRoot, 'test-results');
    await mkdir(reviewDirectory, { recursive: true });
    await options.screenshot({
      path: path.join(reviewDirectory, 'visual-review-options-dictionary-390x844.png'),
    });
    await options.close();

    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
    await dashboard.getByRole('button', { name: 'New doc', exact: true }).first().waitFor();
    await dashboard.getByRole('button', { name: 'New doc', exact: true }).first().click();
    await dashboard.locator('#editor-container').waitFor({ state: 'visible' });
    await dashboard.locator('#editor-title').fill('A note for Friday');
    await dashboard.locator('#editor-textarea').fill(
      'The briefing is nearly ready. They will recieve the parcel tommorow. Your welcome to review it.',
    );
    await dashboard.locator('.suggestion-card').first().waitFor({
      state: 'visible',
      timeout: 20_000,
    });
    await waitForFonts(dashboard);
    await dashboard.screenshot({
      path: path.join(assetDirectory, 'screenshot-writing-workspace-1280x800.png'),
    });
    await dashboard.close();
  } finally {
    await context?.close();
    await stopServer(server);
    await rm(profile, { recursive: true, force: true });
  }
}

async function capturePromotionalTile() {
  const browser = await chromium.launch({
    headless: true,
    ...(customChromium ? { executablePath: customChromium } : { channel: 'chromium' }),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
    await page.goto(pathToFileURL(path.join(assetDirectory, 'promo-tile.html')).href);
    await waitForFonts(page);
    await page.screenshot({
      path: path.join(assetDirectory, 'small-promotional-tile-440x280.png'),
    });
  } finally {
    await browser.close();
  }
}

async function captureStoreIcon() {
  const browser = await chromium.launch({
    headless: true,
    ...(customChromium ? { executablePath: customChromium } : { channel: 'chromium' }),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    const iconData = await readFile(path.join(repositoryRoot, 'public', 'icon', '128.png'));
    const iconUrl = `data:image/png;base64,${iconData.toString('base64')}`;
    await page.setContent(`
      <!doctype html>
      <style>
        html, body { width: 128px; height: 128px; margin: 0; background: transparent; }
        body { display: grid; place-items: center; }
        img { display: block; width: 96px; height: 96px; object-fit: contain; }
      </style>
      <img src="${iconUrl}" alt="" />
    `);
    await page.locator('img').waitFor();
    await page.screenshot({
      path: path.join(assetDirectory, 'store-icon-128x128.png'),
      omitBackground: true,
    });
  } finally {
    await browser.close();
  }
}

await capturePromotionalTile();
await captureStoreIcon();
await captureProductScreenshots();
await assertPngDimensions('small-promotional-tile-440x280.png', 440, 280);
await assertPngDimensions('store-icon-128x128.png', 128, 128);
await assertPngDimensions('screenshot-privacy-setup-1280x800.png', 1280, 800);
await assertPngDimensions('screenshot-language-dictionary-1280x800.png', 1280, 800);
await assertPngDimensions('screenshot-writing-workspace-1280x800.png', 1280, 800);
console.log('Captured Chrome Web Store assets in docs/store-assets.');
