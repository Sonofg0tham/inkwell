# Release checklist

Use this checklist before handing an Inkwell build to another person or uploading it to a browser store.

## Code and dependency gates

- Use Node.js 22.13 or newer.
- Install from the lockfile with `npm.cmd ci`.
- Run `npm.cmd audit --omit=dev --audit-level=high`. Do not ship with a high or critical production advisory.
- Run `npm.cmd audit --audit-level=high` for the full toolchain. Do not use `npm audit fix --force` without checking the proposed framework changes and rerunning every gate below.
- Run `npm.cmd run typecheck` and `npm.cmd test`.

## Browser gates

- Run `npm.cmd run build`.
- Install Playwright Chromium once with `npm.cmd run test:e2e:install`, then run `npm.cmd run test:e2e`.
- Confirm the first-run popup and options page keep checking off until the privacy checkpoint is accepted.
- Load `.output/chrome-mv3` manually in Chrome or Edge and test one ordinary website, one contenteditable editor, and the document workspace.
- Confirm that the popup, options page, badge count, accept, dismiss, undo, site disable, and provider error states behave as expected.
- Confirm the generated manifest declares Chrome 119 as the minimum supported version and includes origin-fallback injection for related `data:`, `blob:` and `filesystem:` frames.
- Run `npm.cmd run build:edge` and check that `.output/edge-mv3/manifest.json` exists.

## Local-model gates

- Start Ollama or the supported local OpenAI-compatible server.
- Test the exact model shown in settings.
- Check spelling, grammar, punctuation, and style on short text and a multi-paragraph document.
- Disconnect the server during a check and confirm that Inkwell reports the failure without losing the user's text.
- Confirm that no page text is sent anywhere until the user has edited an eligible field.
- With a cloud provider selected, confirm each website remains off until explicitly enabled and that the disclosure says workspace documents are sent to that provider when checked.

## Packaging and sharing

- Review the generated manifest permissions and store disclosure text.
- Confirm the version in `package.json` matches the intended release.
- Generate the archive with `npm.cmd run zip` only after every gate above passes.
- Inspect the archive contents before upload. Do not include test results, traces, credentials, local environment files or development-only source maps.
- Extract that exact ZIP into a new empty folder, set `INKWELL_EXTENSION_PATH` to the extracted folder, and rerun `npm.cmd run test:e2e`. Do not rely only on the unzipped development build.
- Run `node docs/store-assets/capture-store-assets.mjs` after the final Chrome build. It must produce and dimension-check the 128 x 128 icon, 440 x 280 tile and both 1280 x 800 screenshots listed in `docs/store-assets/README.md`.
- Open each generated store PNG and check that the text is legible, no private data is visible and the screenshot matches the current extension.
- Publish `PRIVACY.md` at a stable HTTPS URL, then confirm it opens without authentication or a repository account. Use that exact URL in the store listing.
- In the public GitHub repository, enable Private vulnerability reporting under **Settings > Security > Code security and analysis**.
- Keep the release as a draft until the packaged archive has passed a final manual smoke test.
