import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Inkwell',
    description:
      'Grammar and spelling assistant powered by your own local or cloud LLM. Your text, your model, your choice.',
    permissions: ['storage', 'activeTab'],
    host_permissions: [
      // Chrome match patterns ignore ports, so this covers Ollama :11434 and LM Studio :1234
      'http://localhost/*',
      'http://127.0.0.1/*',
      'https://api.openai.com/*',
      'https://api.anthropic.com/*',
    ],
    // Custom base URLs (e.g. a LAN Ollama box) are granted at save-time in the
    // options page via chrome.permissions.request — never a blanket grant.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
});
