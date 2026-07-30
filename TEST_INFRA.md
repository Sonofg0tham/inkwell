# Inkwell test infrastructure

Inkwell uses two complementary test layers. Vitest covers the application logic and browser API boundaries quickly. Playwright then loads the built extension into real Chromium and checks the parts a DOM mock cannot prove.

## Prerequisite

Use Node.js 22.13 or newer. The requirement is enforced in `package.json` and matches the minimum used by the document-import stack.

## Unit and integration tests

Run:

```powershell
npm.cmd test
```

Vitest covers the checker pipeline, provider validation, settings and storage boundaries, editable-field handling, overlays, popup behaviour, document import and export, and dashboard workflows. Browser APIs are supplied by `tests/helpers/chrome-mock.ts`; DOM-heavy tests opt into Happy DOM.

These tests are deterministic and do not require Ollama or a cloud API key. Tests which probe a real local model are explicitly gated and skip when their opt-in environment variable is absent.

The test command caps Vitest at four workers. Dictionary initialisation is CPU-heavy, and allowing every file to start a worker at once made short asynchronous assertions unreliable on high-core machines and CI runners.

## Installed-extension smoke test

Install the bundled Playwright Chromium once:

```powershell
npm.cmd run test:e2e:install
```

Build and test the extension:

```powershell
npm.cmd run build
```

```powershell
npm.cmd run test:e2e
```

The smoke test launches a fresh, persistent Chromium context with `.output/chrome-mv3` installed. It checks the consent gate, configures a private loopback model fixture, and opens the workspace. Trusted keyboard input then exercises a single-line input, textarea, contenteditable surface and same-origin embedded editor. It verifies suggestions and badge counts in all four, and applies fixes by keyboard in the three top-level editors.

No external service or user-installed model is contacted. The loopback fixture behaves like Ollama and returns deterministic test data, while the opt-in real-model suites cover actual model communication separately.

If Chromium is already available somewhere else, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable before running the smoke test. This is useful in restricted or offline environments.

To test the exact release archive, extract the ZIP into a new empty folder, set `INKWELL_EXTENSION_PATH` to that folder's absolute path, then run `npm.cmd run test:e2e`. The test loads that extracted copy instead of the normal build directory.

## Release verification

Before sharing a build, run these commands in order:

```powershell
npm.cmd ci
```

```powershell
npm.cmd audit --omit=dev --audit-level=high
```

```powershell
npm.cmd audit --audit-level=high
```

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

CI repeats these checks on pushes and pull requests to `main`, including the full dependency audit. A development-only advisory still needs a reachability assessment before forcing a breaking framework downgrade, but it is not silently excluded from the gate.

### Dependency hardening recorded on 29 July 2026

The live npm install audit initially reported six high-severity development advisories through WXT's old `web-ext-run` chain and PostCSS. Inkwell moved to exact WXT 0.21.2, which replaced that runner, and requires patched PostCSS 8.5.18 or newer. The subsequent live install audit reported zero vulnerabilities, and `web-ext-run`, `firefox-profile`, `adm-zip`, and `brace-expansion` are no longer present in the installed tree.

## Generated files

Playwright writes traces, screenshots, HTML reports, and temporary browser profiles under `test-results/`, `playwright-report/`, or `blob-report/`. Those folders, along with local `.playwright-mcp/` artefacts, are intentionally ignored by Git.
