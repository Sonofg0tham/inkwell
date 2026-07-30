# Chrome Web Store listing pack

Prepared for Inkwell's first public beta. Keep this file aligned with the extension, the in-product disclosure and `PRIVACY.md` before every submission.

## Product details

**Name:** Inkwell

**Category:** Productivity

**Language:** English (UK)

**Short description:** User-controlled spelling and grammar checks across the web, using a local model or cloud provider you choose.

**Detailed description:**

Inkwell checks spelling, grammar, punctuation and style in ordinary text fields across the web. You choose the model. Run Ollama or LM Studio on your own computer, connect a custom compatible server, or bring an API key for a supported cloud provider.

Inkwell includes:

- Inline underlines with explanations, Apply, Dismiss, Ignore all and personal dictionary actions.
- Deterministic local spelling and high-confidence grammar rules, even when contextual model checking is unavailable.
- British, American, Canadian, Australian and Indian English settings.
- Keyboard-accessible suggestion review and clear checking, partial and error states.
- Per-site controls, with cloud processing disabled until you enable a site.
- A local document workspace with TXT, Markdown, DOCX and PDF import, export and optional manual Markdown folder copies.
- Ollama, LM Studio, OpenAI-compatible, OpenRouter, Gemini, OpenAI and Anthropic provider choices.

There is no Inkwell account, telemetry or advertising. Settings, keys and workspace documents stay in your browser profile. Text is sent only to the provider you configure. Local providers keep the proofreading path on your machine. Cloud providers receive website text only on sites you explicitly enable, and receive workspace text when Inkwell checks an open document.

A compatible model provider is required for contextual grammar, clarity and tone checks. Deterministic spelling and high-confidence rules still run if that provider is unavailable. Model quality varies, so Settings runs a structured proofreading test before describing a model as connected. Google Docs is not supported because its editor does not expose normal editable DOM text. This beta targets Chromium browsers, including Chrome and Edge.

## Single purpose

Provide user-controlled spelling, grammar and writing suggestions in web editors and Inkwell's local document workspace.

## Permission justifications

**storage:** Stores settings, the personal dictionary, site choices, provider credentials and user-created workspace documents locally in the browser.

**unlimitedStorage:** Allows users to keep larger imported documents in the local workspace without silently hitting Chrome's standard extension-storage quota.

**activeTab:** Reads the hostname of the tab where the user opens the popup, so the visible per-site enable or disable control applies to the correct site.

**Content-script access to web pages:** Finds supported editable fields and draws proofreading controls beside text the user edits. Inkwell uses field types, autocomplete metadata, labels and common editor markers to skip recognised sensitive fields and code editors, and respects fields which disable spellchecking. Custom fields may not expose enough information to identify them, so users can disable Inkwell for any site.

**Required loopback host access:** Connects to Ollama or LM Studio on `localhost` or `127.0.0.1`. These are the default local-provider paths.

**Optional HTTPS host access:** Supports cloud providers and user-specified HTTPS model servers. Inkwell asks for the exact saved origin during a direct user action. The broad optional declaration is only the manifest ceiling needed to support arbitrary user-chosen servers.

## Privacy practices answers

Disclose that the extension handles:

- Website content, form data and user-generated content, limited to text in supported editable fields that the user actively edits.
- Personal communications when a supported editor contains them.
- Authentication information in the form of provider API keys supplied by the user.
- User-created or imported documents stored in the local workspace.
- Hostnames deliberately added to disabled-site or cloud-enabled-site lists.
- Web browsing activity, limited to the active hostname used for the visible site control and hostnames deliberately saved in those lists.

Do not claim that Inkwell handles no user data merely because local providers and browser storage are available. Chrome's policy treats local processing and storage as data handling.

**Remote code:** No. All executable JavaScript is packaged with the extension. Model responses are parsed as untrusted JSON data and are never executed.

Certify that data use is limited to the disclosed proofreading and document features, is not used for advertising or unrelated purposes, is not sold, and is not made available for human reading. Use the public privacy-policy URL:

`https://github.com/Sonofg0tham/inkwell/blob/main/PRIVACY.md`

## Public links

- Homepage: `https://github.com/Sonofg0tham/inkwell`
- Support: `https://github.com/Sonofg0tham/inkwell/issues`
- Security reports: `https://github.com/Sonofg0tham/inkwell/security/advisories/new`
- Privacy policy: `https://github.com/Sonofg0tham/inkwell/blob/main/PRIVACY.md`

Craig can also verify `sonofg0tham.dev` in Google Search Console and use it as the official publisher URL.

## Assets prepared for the developer dashboard

- `docs/store-assets/store-icon-128x128.png`
- `docs/store-assets/screenshot-privacy-setup-1280x800.png`
- `docs/store-assets/screenshot-language-dictionary-1280x800.png`
- `docs/store-assets/screenshot-writing-workspace-1280x800.png`
- `docs/store-assets/small-promotional-tile-440x280.png`
- Optional `1400x560` marquee image.
- Optional YouTube product video.

Use real current UI in screenshots. Good candidates are the consent and model setup, an inline correction, keyboard review, the document workspace, and per-site cloud control. Avoid unsupported claims, ratings, testimonials and comparisons that imply endorsement by another writing product.

## Manual submission steps

1. Register or open the Chrome Web Store developer account.
2. Upload the ZIP produced by `npm.cmd run zip`.
3. Add the listing copy and current assets.
4. Complete the Privacy practices tab using the answers above.
5. Set the distribution regions and public visibility.
6. Submit for review. Do not publish until the final release checklist and installed-extension smoke test are green for the exact ZIP.
