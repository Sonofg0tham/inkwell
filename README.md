# Inkwell

Inkwell is a privacy-first spelling and grammar assistant for Chromium browsers. It checks ordinary web editors and a built-in document workspace using a model you choose, including Ollama or LM Studio running on your own computer.

This is a public beta for Chrome and Edge. It covers the core proofreading workflow well, but it is not presented as a complete replacement for a mature commercial writing suite.

## What it does

- Checks text inputs, textareas and contenteditable editors across ordinary websites.
- Combines offline English dictionaries and high-confidence grammar rules with contextual model suggestions.
- Shows accessible inline underlines with Apply, Dismiss, Ignore all and Add to dictionary actions.
- Supports British, American, Canadian, Australian and Indian English.
- Offers standard and detailed review modes for spelling, grammar, punctuation and style.
- Keeps a personal dictionary and global, per-site and blocklist controls.
- Includes a local document workspace with TXT, Markdown, DOCX and PDF import, several export formats, trash and optional folder copies.
- Connects to Ollama, LM Studio, compatible custom servers, OpenRouter, Gemini, OpenAI and Anthropic.

Inkwell uses field types, autocomplete metadata, labels and common editor markers to skip recognised sensitive fields and code editors. It also respects fields which explicitly disable spellchecking. Custom fields may not expose enough information to identify them, so disable Inkwell on any site where you do not want text checked. Google Docs is not supported because its editor does not expose normal editable DOM text.

## Privacy model

Inkwell has no account, analytics, advertising or developer-operated text server. Settings, provider keys, personal dictionary entries and workspace documents stay in the browser profile.

Text is sent only to the provider configured by the user. Local loopback providers keep the proofreading request on the same machine. Cloud and remote custom providers require an exact origin permission, and website checking stays off for each site until the user enables it. An open workspace document is sent to the selected cloud provider when Inkwell checks it.

Read [PRIVACY.md](PRIVACY.md) for the full data-handling policy and [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Requirements

- Chrome or Edge 119 or newer.
- Node.js 22.13 or newer to build from source.
- A supported local model server or a user-supplied cloud API key.

The default Ollama model is `qwen2.5:7b-instruct`, which gave the most reliable results during the local acceptance run. Other models can be selected, but model quality varies. Settings performs a structured proofreading check before reporting a connection as ready.

## Build and load

Install from the lockfile:

```powershell
npm.cmd ci
```

Build the Chrome extension:

```powershell
npm.cmd run build
```

Open `chrome://extensions` or `edge://extensions`, enable Developer mode, choose **Load unpacked**, then select `.output/chrome-mv3`.

The first-run settings page explains what Inkwell processes. Accept that disclosure before checking text.

## Connect Ollama

Install the recommended model:

```powershell
ollama pull qwen2.5:7b-instruct
```

Ollama must allow the installed extension's exact origin. Open Inkwell Settings and copy the `OLLAMA_ORIGINS=chrome-extension://...` value shown under the server address. Set that value in the environment used to start Ollama, then restart Ollama. Avoid a wildcard origin.

Back in Settings, choose Ollama, fetch the model list, select the model, then choose **Save & test**.

LM Studio works through the OpenAI-compatible option. Start its local server and enable CORS in LM Studio before testing the connection.

## Verify a build

Run the automated gates in this order:

```powershell
npm.cmd run typecheck
```

```powershell
npm.cmd test
```

```powershell
npm.cmd run build
```

```powershell
npm.cmd run test:e2e
```

```powershell
npm.cmd run build:edge
```

The Playwright test loads the built extension into real Chromium. It proves first-run consent, model setup through a loopback fixture, trusted typing, badge updates, closed-shadow suggestions, keyboard Apply and checking inside an `srcdoc` iframe.

Real-model probes are opt-in so normal tests stay deterministic. See [TEST_INFRA.md](TEST_INFRA.md) and [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for the complete release process.

## Package for sharing

Create the Chrome Web Store archive only after every release gate passes:

```powershell
npm.cmd run zip
```

The listing copy and privacy answers are in [docs/chrome-web-store-listing.md](docs/chrome-web-store-listing.md). Store artwork lives in [docs/store-assets](docs/store-assets).

## Current scope

Inkwell currently targets Chrome and Edge. Firefox, Safari, Google Docs, multilingual checking, collaborative documents, plagiarism detection and generative rewrite tools are not part of this beta.

The model remains an untrusted adviser. Responses are schema-checked, anchored to the original text and never applied without a user action. A malicious or poor-quality model can still suggest an unhelpful edit, so review suggestions before applying them.
