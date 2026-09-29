# LayerGrab plugins

Source code of the [LayerGrab](https://layergrab.com) plugins for **Figma** and **Chrome**, and the small client library they share. LayerGrab splits one image into up to 16 separate transparent layers, one per element, with the background filled in behind them, or pulls out just the object you name. This repository is the code that runs inside the design tool; the splitting itself happens on LayerGrab's servers with a LayerGrab account.

- Figma: [layergrab.com/figma-plugin](https://layergrab.com/figma-plugin)
- Chrome: [layergrab.com/chrome-extension](https://layergrab.com/chrome-extension)
- Web app, Photoshop and Sketch: [layergrab.com](https://layergrab.com)

Published so that reviewers and users can read what the plugins do. Issues and pull requests are welcome; the Photoshop and Sketch plugins are not in this repository yet.

## What is here

```
packages/core/     Shared CommonJS client: sign-in (device flow), account, split, unlock, result mapping
plugins/figma/     Figma plugin: src/code.js (main thread), ui.html (panel), manifest.json
plugins/chrome/    Chrome extension (Manifest V3): side panel, context menu, background worker
scripts/           Copies packages/core/hub.js into plugins/chrome/lib (Chrome loads only its own files)
```

`packages/core/hub.js` talks to `api.layergrab.com`. It is plain CommonJS with no design-tool APIs, so the same file runs in Figma's plugin sandbox, in a Chrome extension, in Photoshop's UXP runtime and under Node for the tests. The app key in it is a public identifier, not a secret; a user's own key is only ever issued to that user after they approve the plugin in their browser.

## How sign-in works

The plugin never sees a password. It asks LayerGrab for a short code, opens `layergrab.com/account/connect?code=…` in the browser, and polls until the user has signed in with Google there and clicked **Approve**. The key it receives is stored in the design tool's plugin storage (`figma.clientStorage`, `chrome.storage.local`) and can be revoked from the account page at any time.

## Build and run

Requires Node 18+ and pnpm.

```bash
pnpm install:all          # packages/core and plugins/figma
pnpm test                 # the core against a scripted fake of the API
pnpm build                # copies the core into the Chrome extension and bundles the Figma plugin
```

- **Figma**: in the desktop app, Plugins › Development › Import plugin from manifest… and pick `plugins/figma/manifest.json`, then run it from the Development menu.
- **Chrome**: open `chrome://extensions`, turn on Developer mode, Load unpacked, choose `plugins/chrome`.

Both need a LayerGrab account. New accounts in supported regions get free credits; a split is charged per layer returned, and a result the balance cannot cover is shown locked until it is paid for, nothing is charged before that.

## Licence

MIT, see [LICENSE](LICENSE). Vendored decoders in `packages/core/vendor` keep their own licences (jpeg-js, pako, UPNG).
