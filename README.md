# Inkwell

A Grammarly-style browser extension you fully control. It checks grammar and spelling in text boxes across the web, and **you** choose the brain: a local model (Ollama or LM Studio) so nothing leaves your machine, or your own cloud API key (OpenAI, Anthropic, or any OpenAI-compatible endpoint).

No account. No telemetry. Your text only ever goes to the provider you configured.

## Features

- Underlines spelling, grammar, punctuation and style issues in `<textarea>`, text inputs and rich-text editors (Gmail, GitHub, LinkedIn and friends)
- Hover an underline for a suggestion card with one-click **Apply** (undo-friendly, works in React apps) and **Dismiss**
- Providers: **Ollama** (local, default), **LM Studio / any OpenAI-compatible server**, **OpenAI**, **Anthropic**
- UK English by default (switchable to US), with formality and strictness settings
- Global on/off, per-site toggle, and a site blocklist
- Badge shows the suggestion count for the current tab

Google Docs is out of scope (it renders text on a canvas, not the DOM).

## Setup

### 1. Build

```
npm install
npm run build
```

The extension is emitted to `.output/chrome-mv3`.

### 2. Load it in Chrome or Edge

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode** (toggle in the corner)
3. Click **Load unpacked** and pick the `.output/chrome-mv3` folder

### 3. Point it at a model

Open the Inkwell popup → **Open settings**.

**Ollama (recommended local option)** — Ollama checks the `Origin` header, so it must be started with extensions allowed:

```
setx OLLAMA_ORIGINS "chrome-extension://*"
```

Then restart Ollama, and pull a model if you haven't:

```
ollama pull qwen2.5:7b-instruct
```

In Inkwell settings, click **Fetch models**, pick one, then **Save & test**.

**LM Studio** — start its local server and enable **CORS** in the server settings, then choose "LM Studio / OpenAI-compatible" in Inkwell.

**OpenAI / Anthropic** — paste your API key. It is stored only on this device (`chrome.storage.local`), never synced, never logged. Note: with a cloud provider, text you type on checked pages is sent to that provider.

## Trying it out

Open `playground/test-page.html` in the browser (enable "Allow access to file URLs" for Inkwell on the extensions page, or serve the folder). It contains pre-broken text in every kind of field, including a React-controlled textarea and fields Inkwell must ignore.

## Development

```
npm run dev        # dev mode with auto-reload
npm run typecheck  # TypeScript
npm test           # unit tests (+ a live Ollama round-trip when it's running)
npm run build      # production build (add :edge for an Edge-targeted build)
npm run zip        # store-ready zip
```

`scripts/make-previews.mjs` + `scripts/serve-preview.mjs` render the popup and options pages in a normal tab (with a stubbed `chrome` API) for quick visual review.

## Security notes

- **API keys** live in `chrome.storage.local` under a dedicated key, are read only by the background service worker, and never appear in messages, logs or content scripts.
- **Model output is treated as untrusted**: responses are schema-validated, suggestions are located by verbatim substring match (never model-reported offsets), replacements are sanitised, and nothing is ever applied without your click.
- **Prompt injection**: page text is wrapped in randomised data markers and the system prompt refuses instructions inside it. Worst case, a malicious page can only *suggest* an edit you'd still have to click.
- **Permissions** are minimal: static host access covers only `localhost`, `api.openai.com` and `api.anthropic.com`; any custom server address triggers an explicit permission prompt when you save it.
- Known limitation (Medium): like nearly all extensions, `chrome.storage.local` is readable by the extension's own content scripts, so a full renderer compromise on a malicious page could in theory reach stored keys. Prefer local providers if that worries you.

## Architecture (short version)

- `entrypoints/background.ts` — service worker: all network calls, check queue (concurrency 2, LRU cache), badge
- `entrypoints/content.ts` + `lib/content/` — finds editable fields, renders underlines in a shadow-DOM overlay (the page's DOM is never mutated), applies fixes via `execCommand('insertText')` so undo and React both keep working
- `lib/providers/` — one small adapter per provider behind a common interface
- `lib/checker/` — prompt builder, response validation, chunking/hashing, and the anchor matcher
- `entrypoints/popup/`, `entrypoints/options/` — UI, themed from `brand.md` / `brand-theme.css`
