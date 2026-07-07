// Generates preview-popup.html / preview-options.html inside .output/chrome-mv3
// with a stubbed chrome API, so the extension pages can be opened in a normal
// browser tab for visual review. Dev tooling only — never shipped.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('.output', 'chrome-mv3');

const STUB = `<script>
  // Preview-only chrome stub. The real pages run inside the extension.
  window.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: async (msg) => {
        if (msg && msg.t === 'getTabState') {
          return { enabled: true, host: 'github.com', siteDisabled: false, issueCount: 3 };
        }
        if (msg && msg.t === 'listModels') {
          return { ok: true, models: ['llama3.1:8b', 'mistral:7b', 'qwen2.5:14b'] };
        }
        return { ok: true };
      },
      openOptionsPage: async () => {},
    },
    permissions: { request: async () => true },
    tabs: { query: async () => [] },
    action: {},
  };
</script>`;

for (const page of ['popup', 'options']) {
  const html = await readFile(path.join(OUT, `${page}.html`), 'utf8');
  const patched = html.replace('<head>', `<head>${STUB}`);
  await writeFile(path.join(OUT, `preview-${page}.html`), patched);
  console.log(`wrote preview-${page}.html`);
}
