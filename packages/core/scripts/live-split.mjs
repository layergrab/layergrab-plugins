// Manual end-to-end check of the plugin's non-Photoshop path, exactly as the
// panel runs it: base64 JPEG upload → split → download/decode/resize/place.
// Usage: node scripts/live-split.mjs <image.jpg|png> [out-dir]   (costs ~$0.20–0.30)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createSplitTask, pollTask } = require('../api.js')
const { buildPixelLayers } = require('../pipeline.js')
const { decodeImage } = require('../decode.js')

const [, , input, outDir = 'tmp-live'] = process.argv
const raw = fs.readFileSync(path.join(os.homedir(), '.apimodels/credentials'), 'utf8')
const apiKey = (raw.match(/sk[_-][A-Za-z0-9_-]+/) || [raw.trim()])[0]
const bytes = fs.readFileSync(input)
const mime = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg'
const img = decodeImage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
const t0 = Date.now()
const taskId = await createSplitTask({ apiKey, imageDataUrl: `data:${mime};base64,${bytes.toString('base64')}` })
console.log('task', taskId)
const result = await pollTask({ apiKey, taskId, onTick: (ms, st) => process.stdout.write(`\r${Math.round(ms / 1000)}s ${st}   `) })
console.log(`\nsplit done in ${Math.round((Date.now() - t0) / 1000)}s: base + ${result.layers.length} layers`)
const layers = await buildPixelLayers(result, { width: img.width, height: img.height }, (d, t) => process.stdout.write(`\rdownloaded ${d}/${t}`))
console.log()
fs.mkdirSync(outDir, { recursive: true })
const UPNG = require('../vendor/upng.js')
layers.forEach((L, i) => {
  console.log(`${i}. ${L.name}  @${L.left},${L.top} ${L.width}x${L.height}`)
  fs.writeFileSync(path.join(outDir, `${String(i).padStart(2, '0')}.png`), Buffer.from(UPNG.encode([L.data.buffer.slice(L.data.byteOffset, L.data.byteOffset + L.data.byteLength)], L.width, L.height, 0)))
})
