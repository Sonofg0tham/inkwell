# Chrome Web Store assets

- `small-promotional-tile-440x280.png`, 440 x 280 pixels. Rendered from `promo-tile.html` using Inkwell's bundled fonts, icon and brand palette.
- `store-icon-128x128.png`, 128 x 128 pixels. The packaged mascot centred at 96 x 96 with transparent store-safe padding.
- `screenshot-privacy-setup-1280x800.png`, 1280 x 800 pixels. Captured from the first-run privacy checkpoint in the installed Chrome MV3 build.
- `screenshot-language-dictionary-1280x800.png`, 1280 x 800 pixels. Captured from the installed settings page with all five dialects and a personal dictionary entry visible.
- `screenshot-writing-workspace-1280x800.png`, 1280 x 800 pixels. Captured from the installed dashboard while a local fixture model returns proofreading suggestions.

Run `node docs/store-assets/capture-store-assets.mjs` from the repository root after building the extension. The script uses only a loopback fixture server and does not call an external model or service.
