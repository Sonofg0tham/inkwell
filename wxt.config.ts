import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Inkwell',
    description:
      'Grammar and spelling assistant powered by your own local or cloud LLM. Your text, your model, your choice.',
    minimum_chrome_version: '102',
    // unlimitedStorage lifts chrome.storage.local off its 10 MB cap, which an
    // imported PDF can exhaust on its own. It shows no extra install warning.
    permissions: ['storage', 'unlimitedStorage', 'activeTab'],
    host_permissions: [
      // Chrome match patterns ignore ports, so this covers Ollama :11434 and LM Studio :1234
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    // Cloud providers and custom base URLs are granted only after the user
    // selects them. The options page requests the exact origin, never the
    // blanket patterns declared here as the optional-permission ceiling.
    optional_host_permissions: ['https://*/*'],
  },
});
