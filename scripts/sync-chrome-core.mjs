// The Chrome extension loads files only from its own folder, so the shared
// account and split client is copied into plugins/chrome/lib before loading or
// packaging it. The copy is gitignored: edit packages/core, never the copy.
import fs from 'node:fs'

fs.copyFileSync('packages/core/hub.js', 'plugins/chrome/lib/hub.js')
console.log('synced packages/core/hub.js → plugins/chrome/lib/hub.js')
