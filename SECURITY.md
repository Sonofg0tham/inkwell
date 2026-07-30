# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through [GitHub's private security advisory form](https://github.com/Sonofg0tham/inkwell/security/advisories/new). Do not open a public issue for an unpatched vulnerability and do not include live API keys or somebody else's data.

Include the affected version, browser, reproduction steps, likely impact and any proof-of-concept material that is safe to share. Reports that explain the trust boundary or data path are especially useful.

## Supported versions

Inkwell is currently pre-release software. Security fixes are applied to the latest published version and the `main` branch. Older unpacked builds are not supported after a fixed release is available.

## Security boundaries

Inkwell treats website text and model output as untrusted. Model network requests run in the background service worker. Website content scripts never receive provider credentials. Checks require trusted user input, request budgets are scoped by client and origin, and the in-page interface uses a closed shadow root. Suggestions are schema-checked, anchored against the original text and applied only after a user action.

Remote model endpoints must use HTTPS. Plain HTTP is accepted only for a model on the local loopback interface. Cloud and custom origins require a user-approved host permission, and cloud proofreading also requires per-site consent.

The repository runs TypeScript checks, unit and integration tests, an installed-extension Chromium smoke test, production builds, dependency review, CodeQL and secret scanning in CI.

## Scope notes

Useful reports include secret exposure, unauthorised provider requests, permission bypasses, unsafe text replacement, cross-site data leaks, stored-document exposure and build or update compromise.

Security problems in Ollama, a cloud model provider, the browser itself or a user-configured remote server should normally be reported to that project. A provider issue is still relevant here if Inkwell exposes it through unsafe defaults or incorrect integration.

## Good-faith research

Please avoid accessing data that is not yours, degrading a third-party service or publishing exploit details before a fix is available. Good-faith testing against your own Inkwell installation and model endpoints is welcome.
