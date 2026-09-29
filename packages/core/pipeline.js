// Turns a finished split into canvas-ready pixel layers: download each image,
// decode it, resize it to its box and clip it to the document. Photoshop-free,
// so test/pipeline.test.js runs the exact same code against saved API results.

const { decodeImage } = require('./decode.js')
const { planPlacement, resizeRGBA, clipToCanvas } = require('./layout.js')

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not download a layer (HTTP ${res.status}).`)
  return res.arrayBuffer()
}

/**
 * @param {{ base: {url}, layers: Array }} result  from api.pollTask
 * @param {{ width: number, height: number }} docSize
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns bottom-to-top list of { name, description, left, top, width, height, data }
 */
async function buildPixelLayers(result, docSize, onProgress, fetchBytes = download) {
  const total = result.layers.length + 1
  let done = 0
  const tick = () => onProgress && onProgress(++done, total)

  const base = decodeImage(await fetchBytes(result.base.url))
  tick()
  const out = [
    {
      name: 'Background (filled)',
      description: 'Background with every separated element removed and the hidden area filled in.',
      left: 0,
      top: 0,
      width: docSize.width,
      height: docSize.height,
      data: resizeRGBA(base.data, base.width, base.height, docSize.width, docSize.height),
    },
  ]

  const plans = planPlacement(result.layers, { width: base.width, height: base.height }, docSize)
  // Downloads run in parallel; decoding and resizing stay sequential to keep
  // peak memory at one full-resolution crop at a time.
  const buffers = plans.map((p) => fetchBytes(p.url))
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i]
    const img = decodeImage(await buffers[i])
    const sized = resizeRGBA(img.data, img.width, img.height, p.width, p.height)
    const clipped = clipToCanvas(sized, p.width, p.height, p.left, p.top, docSize.width, docSize.height)
    tick()
    if (!clipped) continue
    out.push({ name: p.name, description: p.description, ...clipped })
  }
  return out
}

module.exports = { buildPixelLayers }
