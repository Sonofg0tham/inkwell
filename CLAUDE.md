# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Inkwell is a Manifest V3 browser extension (Chrome and Edge 119+) built with WXT and TypeScript. It proofreads text in web editors and in a built-in document workspace, using offline dictionaries and grammar rules plus an LLM the user chooses (Ollama, LM Studio, custom OpenAI-compatible servers, OpenRouter, Gemini, OpenAI, Anthropic). Privacy and security boundaries are the core design constraint, and many tests exist purely to enforce them.

The maintainer works on Windows and the docs use `npm.cmd`; plain `npm` works the same elsewhere.

## Commands

Requires Node.js 22.13+. `npm ci` also runs `wxt prepare`, which generates `.wxt/` (the root `tsconfig.json` extends `.wxt/tsconfig.json`, so typecheck fails without it).

- `npm run dev` / `npm run dev:edge`: WXT dev mode with hot reload
- `npm run typecheck`: `tsc --noEmit`
- `npm test`: Vitest, capped at 4 workers (dictionary loading is CPU-heavy, more workers made async assertions flaky)
- Single test file: `npx vitest run tests/checker.test.ts`; single test by name: add `-t "name"`
- `npm run build` → `.output/chrome-mv3`; `npm run build:edge` → `.output/edge-mv3`
- `npm run test:e2e`: Playwright loads the **built** extension into real Chromium, so run `npm run build` first. One-off setup: `npm run test:e2e:install`
- `npm run zip`: store archive, only after every gate passes

CI (`.github/workflows/ci.yml`) runs, in order: `npm audit --audit-level=high`, typecheck, test, build, e2e, build:edge. Gitleaks, CodeQL and dependency review also run on PRs.

Test environment variables:
- `INKWELL_PROBE=1` enables the opt-in real-model probe (`tests/probe.real-models.test.ts`). The Ollama e2e tests auto-skip when no local server is reachable.
- `INKWELL_EXTENSION_PATH` points Playwright at an extracted release ZIP instead of `.output/chrome-mv3`.
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` uses an existing Chromium (e.g. `/opt/pw-browsers/chromium` in sandboxed environments).

## Architecture

WXT entrypoints live in `entrypoints/`; shared code lives in `lib/`. Imports use relative paths.

**Three trust zones.**
1. `entrypoints/content.ts` runs in every frame (`allFrames`, `matchOriginAsFallback`) beside untrusted pages. It never touches `chrome.storage` (the background locks `storage.local` to `TRUSTED_CONTEXTS`) and never sees API keys. It gets a filtered settings view via the `getContentSettings` message.
2. `entrypoints/background.ts` is the service worker. It owns provider calls, secrets, per-tab/per-frame state (in `storage.session`, sequence-numbered so stale frame reports cannot overwrite newer ones), the badge, and site enable/disable resolution from the trusted top-level tab host.
3. Extension pages (`popup`, `options`, `dashboard` = the document workspace) are trusted and read/write storage directly via `lib/settings/store.ts` and `lib/storage/documents.ts`.

**Messaging** (`lib/messaging/protocol.ts` is the single source of truth for every cross-context message):
- One-shot `chrome.runtime.sendMessage` for the control plane (tab state, settings, test connection, list models, frame state reports), typed via `sendTyped` / `createRouter` in `lib/messaging/typed.ts`.
- A long-lived Port named `inkwell-check` for the data plane: `check` / `cancel` / `ping` requests and `result` responses. `lib/content/portClient.ts` is the client; the dashboard reuses it.
- API keys must never appear in any message payload. Secrets are stored under a separate `secrets` key in `storage.local` (never `storage.sync`) and injected only at fetch time in the background.

**Check pipeline.**
- Content side: `editableWatcher` finds editable fields (including shadow roots and iframes), `editablePolicy` skips sensitive/code/spellcheck-disabled fields, `fieldController` debounces, splits text with `checker/chunker`, hashes chunks (`checker/hash`) and only sends changed chunks.
- Background side: `lib/checker/service.ts` (`CheckService`) queues requests with concurrency 2, an LRU cache, cancellation, and per-Port and per-origin rate/size budgets (`DEFAULT_CHECK_SERVICE_LIMITS`). It merges offline results (`localSpelling` via nspell dictionaries, `localRules`) with the model's response.
- Model output is treated as untrusted: parsed with Zod in `checker/schema.ts`, then `checker/anchor.ts` locates each issue in the original text and drops anything it cannot anchor. Fixes are never applied without a user action (`content/applyFix.ts`).

**Overlay.** `lib/content/overlay/` renders underlines and the suggestion card inside a **closed** shadow root (`overlay/host.ts`). Textarea/input positions come from a mirror element (`overlay/mirror.ts`, `lib/ui/textareaMirror.ts`); contenteditable offsets go through `content/textIndex.ts`.

**Providers.** `lib/providers/registry.ts` maps `ProviderKind` to an implementation (`ollama.ts`, `anthropic.ts`, and `openaiCompat.ts` for LM Studio, OpenRouter, Gemini and OpenAI). `validation.ts` enforces endpoint rules: localhost is a static host permission, while every remote origin needs an exact optional host permission requested by the options page (`optional_host_permissions` in `wxt.config.ts` is only the ceiling). `qualification.ts` runs a structured proofreading test before a connection is reported ready.

**Consent.** Checking stays off until the privacy disclosure is accepted (`CURRENT_DATA_CONSENT_VERSION` in `lib/settings/schema.ts`). With a cloud provider, each website stays off until the user enables it. Bumping the consent version re-gates users.

**Workspace.** `entrypoints/dashboard/main.ts` is the largest file. Import lives in `lib/import/` (PDF.js must stay behind a dynamic `import('./pdf')` and use the `legacy` build, enforced by `tests/release-hygiene.test.ts`); export in `lib/export/` (hand-rolled DOCX/zip writer); documents in `storage.local` (hence `unlimitedStorage`) with optional folder copies via the File System Access API (`lib/storage/folderSync.ts`).

## Tests

Vitest files are in `tests/*.test.ts`; browser APIs come from `tests/helpers/chrome-mock.ts`, and DOM tests opt in with a `// @vitest-environment happy-dom` header. Playwright specs are `tests/extension/*.pw.ts` and use a loopback fixture that imitates Ollama, so no external service is contacted. Several suites (`*-security.test.ts`, `storage.adversarial`, `content-settings-boundary`, `manifest-security`, `release-hygiene`) pin security invariants; if a change trips one, treat it as a design question rather than updating the assertion.

## Conventions

- UK English in user-facing copy and docs.
- Brand rules are in `brand.md` and `brand-theme.css`: they apply to popup, options and dashboard only. The in-page overlay stays neutral, with semantic underline colours. Never teal or green as an accent.
- Release process: `docs/RELEASE_CHECKLIST.md` and `TEST_INFRA.md`.
