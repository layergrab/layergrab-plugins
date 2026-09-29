// Copies the pure-JS image codecs into lib/vendor so the UXP runtime can load
// them with relative require() — UXP does not resolve node_modules packages.
// Run from packages/core.
import fs from 'node:fs'
const out = 'vendor'
fs.mkdirSync(out, { recursive: true })
fs.copyFileSync('node_modules/pako/dist/pako.cjs.js', `${out}/pako.js`)
fs.writeFileSync(
  `${out}/upng.js`,
  fs.readFileSync('node_modules/upng-js/UPNG.js', 'utf8').replace('require("pako")', 'require("./pako.js")'),
)
fs.copyFileSync('node_modules/jpeg-js/lib/decoder.js', `${out}/jpeg-decoder.js`)
for (const f of ['LICENSE']) {
  for (const [pkg, name] of [['pako', 'pako'], ['upng-js', 'upng'], ['jpeg-js', 'jpeg-js']]) {
    const p = `node_modules/${pkg}/${f}`
    if (fs.existsSync(p)) fs.copyFileSync(p, `${out}/${name}.${f}`)
  }
}
console.log('vendored into', out)
