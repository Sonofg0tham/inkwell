# Inkwell privacy policy

Last updated: 29 July 2026

Inkwell is a spelling and grammar browser extension maintained by Craig McCart. It has no user accounts, analytics, advertising or developer-operated text-processing server.

## What Inkwell handles

Inkwell can handle the following data after you accept its in-product privacy disclosure:

- Text that you edit in supported fields, so it can check spelling, grammar, punctuation and style.
- Documents that you create or import in the Inkwell workspace.
- Your provider choice, model name, server address, language settings, personal dictionary, disabled sites and cloud-enabled sites.
- An API key, if you choose a provider that requires one.
- A folder handle, if you choose the optional folder-sync feature.

Inkwell uses field types, autocomplete metadata, labels and common editor markers to skip recognised password, payment, one-time-code, identity, address and code-editor fields. It also respects `spellcheck="false"`. Custom fields may not expose enough information to identify them, so disable Inkwell on any site where you do not want writing checked.

## How the data is used

Text from supported fields is used only to provide proofreading suggestions. Inkwell first runs deterministic spelling and grammar rules on your device. It then sends the relevant text chunk to the model provider you selected for contextual checking.

Inkwell does not use your writing for advertising, profiling, analytics or model training. The developer cannot read your writing through Inkwell because the extension has no developer-operated collection server.

## Where text is sent

If you select Ollama or another model running on your own machine, text is sent to that local program over the loopback interface. Local loopback traffic may use HTTP.

If you select a cloud provider or a remote custom server, text is sent directly from the extension to that provider over HTTPS. Cloud checking starts disabled on every website. You must enable each site from the Inkwell popup before its text can be sent. The provider may process or retain requests under its own terms and privacy policy.

When a cloud provider is selected, opening or editing a workspace document sends its checked text to that provider. The per-site switch applies to website fields, not the Inkwell workspace.

The manifest includes localhost and `127.0.0.1` access for built-in local providers. Other endpoints require a grant for the exact HTTPS origin you save. API keys are attached to requests in the background service worker and are never passed to website content scripts.

## Storage and retention

Settings, site lists, personal dictionary entries, API keys and workspace documents are stored locally in your browser profile using Chrome extension storage. They are not stored with Chrome Sync. Ordinary web-field text is not written to extension storage. A small in-memory result cache can exist while the background service worker is running and is discarded when that worker stops.

Workspace documents remain until you delete them and empty Inkwell's trash, clear the extension's storage, or uninstall the extension. Removing an API key in Settings deletes it from Inkwell storage.

Manual Markdown folder copies are optional and start only after you choose a folder and select **Save copies now**. The folder handle is kept in extension IndexedDB. If the folder is managed by OneDrive, Google Drive, Dropbox or another sync service, that service may upload the resulting files under its own terms. Deleting a workspace document, forgetting the folder or uninstalling Inkwell does not delete Markdown copies already written there. Remove those files yourself when you no longer want them.

## Sharing and human access

Inkwell does not sell user data. It does not share data with the developer, advertisers or data brokers. Text is transferred only to the model endpoint you choose, where that transfer is needed to provide proofreading.

No Inkwell employee or contractor has a system through which they can read your text. If you choose to include text in a support request, that specific material is handled only to answer the request.

## Your choices

You can pause Inkwell globally, disable a site, remove cloud access for a site, delete personal dictionary entries, remove an API key, delete workspace documents, forget a folder handle or uninstall the extension.

## Chrome Web Store Limited Use disclosure

Inkwell's use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data), including the Limited Use requirements. Data is used only for Inkwell's disclosed proofreading and document-workspace features. It is not used for personalised advertising, transferred for unrelated purposes or made available for human reading except when a user deliberately includes specific information in a support request.

## Changes to this policy

If Inkwell's data handling changes, the extension will show an updated disclosure and request consent before the new practice begins. The date at the top of this page will also change.

## Contact

For privacy questions, open an issue in the [Inkwell repository](https://github.com/Sonofg0tham/inkwell/issues). Do not include private text, credentials or API keys in a public issue.
