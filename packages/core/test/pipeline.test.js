// Runs buildPixelLayers on a saved real API result (fixtures/poster) and checks
// that stacking the returned layers reproduces the original poster closely.
// Skipped when the fixtures are absent.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildPixelLayers } = require('../pipeline.js')
const { parseResult } = require('../api.js')
const { decodeImage } = require('../decode.js')

const FIX = path.join(__dirname, 'fixtures', 'poster')

test('stacked layers reproduce the original poster', { skip: !fs.existsSync(FIX) && 'no fixtures' }, async () => {
  const data = JSON.parse(fs.readFileSync(path.join(FIX, 'result.json'), 'utf8')).data
  const result = parseResult(data)
  // Serve each URL from the fixture folder by its z-index file name.
  const byUrl = new Map([[result.base.url, '00.jpg'], ...result.layers.map((l) => [l.url, `${String(l.zIndex).padStart(2, '0')}.png`])])
  const fetchBytes = async (url) => {
    const b = fs.readFileSync(path.join(FIX, byUrl.get(url)))
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }

  const original = decodeImage(fs.readFileSync(path.join(FIX, 'original.png')).buffer)
  const doc = { width: original.width, height: original.height }
  const layers = await buildPixelLayers(result, doc, null, fetchBytes)
  assert.equal(layers.length, result.layers.length + 1)
  assert.equal(layers[0].name, 'Background (filled)')

  // Composite bottom-to-top with straight alpha "over".
  const canvas = new Float32Array(doc.width * doc.height * 3)
  for (const L of layers) {
    for (let y = 0; y < L.height; y++) {
      for (let x = 0; x < L.width; x++) {
        const s = (y * L.width + x) * 4
        const a = L.data[s + 3] / 255
        if (a === 0) continue
        const d = ((y + L.top) * doc.width + (x + L.left)) * 3
        for (let c = 0; c < 3; c++) canvas[d + c] = canvas[d + c] * (1 - a) + L.data[s + c] * a
      }
    }
  }
  let diff = 0
  for (let i = 0; i < doc.width * doc.height; i++) {
    for (let c = 0; c < 3; c++) diff += Math.abs(canvas[i * 3 + c] - original.data[i * 4 + c])
  }
  const mean = diff / (doc.width * doc.height * 3)
  // sharp-based recomposition measured 13.8 at 2x resolution; shadows the model
  // drops account for most of it. Anything far above means misplaced layers.
  assert.ok(mean < 16, `mean abs diff ${mean.toFixed(2)} too high — layers misplaced?`)
  console.log(`   mean abs diff vs original: ${mean.toFixed(2)}`)

  if (process.env.WRITE_PREVIEW) {
    const UPNG = require('../vendor/upng.js')
    const rgba = new Uint8Array(doc.width * doc.height * 4)
    for (let i = 0; i < doc.width * doc.height; i++) {
      rgba.set([canvas[i * 3], canvas[i * 3 + 1], canvas[i * 3 + 2], 255], i * 4)
    }
    fs.writeFileSync(process.env.WRITE_PREVIEW, Buffer.from(UPNG.encode([rgba.buffer], doc.width, doc.height, 0)))
  }
})
