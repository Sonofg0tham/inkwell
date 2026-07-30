// Generates preview-popup.html / preview-options.html / preview-dashboard.html
// inside .output/chrome-mv3 with a stubbed chrome API, so the extension pages
// can be opened in a normal browser tab for visual review. Dev tooling only.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('.output', 'chrome-mv3');

// Sample docs for the dashboard preview
const SAMPLE_DOCS_METADATA = JSON.stringify([
  { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Cover Letter — Senior Engineer', snippet: 'I am writing to express my interest in the Senior Engineer position at your company. With over eight years of…', updatedAt: Date.now() - 3600000, createdAt: Date.now() - 86400000, inTrash: false },
  { id: 'aaaaaaaa-0000-0000-0000-000000000002', title: 'Blog Post Draft', snippet: 'Artificial intelligence has transformed the way we interact with technology. In this article, we explore…', updatedAt: Date.now() - 7200000, createdAt: Date.now() - 172800000, inTrash: false },
  { id: 'aaaaaaaa-0000-0000-0000-000000000003', title: 'Meeting Notes — Q3 Planning', snippet: 'Attendees: Craig, Sarah, Tom. Key decisions: 1) Launch date moved to September. 2) Budget approved…', updatedAt: Date.now() - 86400000, createdAt: Date.now() - 259200000, inTrash: false },
  { id: 'aaaaaaaa-0000-0000-0000-000000000004', title: 'Old Draft', snippet: 'This document was moved to trash.', updatedAt: Date.now() - 500000, createdAt: Date.now() - 600000, inTrash: true },
]);

const DOC_CONTENT_1 = JSON.stringify({ id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Cover Letter — Senior Engineer', content: 'I am writing to express my intrest in the Senior Engineer position at your company. With over eight years of experience in software development, I beleive I am an excellent fit for this role.\n\nThroughout my career, I have demonstarted a strong ability to build scalable systems and colaborate with cross-functional teams. I am particularily proud of my work on distributed infrastructure at my current company, were I led a team of six engineers.\n\nI look forward to discussing how my background aligns with your needs. Thankyou for your consideration.', updatedAt: Date.now() - 3600000, createdAt: Date.now() - 86400000, inTrash: false });

const STUB = `<script>
  // Preview-only chrome stub. The real pages run inside the extension.
  const _store = {
    'inkwell_documents_metadata': ${SAMPLE_DOCS_METADATA},
    'doc_content_aaaaaaaa-0000-0000-0000-000000000001': ${DOC_CONTENT_1},
    'settings': { enabled: true, provider: { kind: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b-instruct' }, dialect: 'en-GB', formality: 'neutral', strictness: 'standard', categories: { spelling: true, grammar: true, punctuation: true, style: true }, disabledSites: [] },
  };
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return { ..._store };
          if (typeof keys === 'string') return { [keys]: _store[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, _store[k]]));
          return Object.fromEntries(Object.keys(keys).map(k => [k, _store[k] ?? keys[k]]));
        },
        set: async (obj) => { Object.assign(_store, obj); },
        remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete _store[k]); },
      },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: async (msg) => {
        if (msg && msg.t === 'getTabState') return { enabled: true, host: 'github.com', siteDisabled: false, issueCount: 3 };
        if (msg && msg.t === 'listModels') return { ok: true, models: ['qwen2.5:7b-instruct', 'llama3.1:8b', 'mistral:7b'] };
        return { ok: true };
      },
      openOptionsPage: async () => {},
      connect: () => ({
        onMessage: { addListener() {} },
        onDisconnect: { addListener() {} },
        postMessage() {},
        disconnect() {},
        name: 'inkwell-check',
      }),
    },
    permissions: { request: async () => true },
    tabs: { query: async () => [] },
    action: {},
  };
</script>`;

for (const page of ['popup', 'options', 'dashboard']) {
  const html = await readFile(path.join(OUT, `${page}.html`), 'utf8');
  const patched = html.replace('<head>', `<head>${STUB}`);
  await writeFile(path.join(OUT, `preview-${page}.html`), patched);
  console.log(`wrote preview-${page}.html`);
}
