// Pure geometry and pixel helpers. No Photoshop APIs, so all of it is tested
// under Node (see test/layout.test.js).

/**
 * Map each layer's box from base-image pixels to document pixels.
 *
 * The API returns the base at its own resolution (2x the upload in testing) and
 * each layer as a high-resolution crop of its box, so every layer has to be
 * resized to its box and then scaled by doc/base before it lands on the canvas.
 * Boxes are clipped to the canvas; a layer that falls entirely outside is dropped.
 */
function planPlacement(layers, baseSize, docSize) {
  const sx = docSize.width / baseSize.width
  const sy = docSize.height / baseSize.height
  const plans = []
  for (const layer of layers) {
    const [x1, y1, x2, y2] = layer.box
    const left = Math.round(x1 * sx)
    const top = Math.round(y1 * sy)
    const width = Math.max(1, Math.round((x2 - x1) * sx))
    const height = Math.max(1, Math.round((y2 - y1) * sy))
    if (left >= docSize.width || top >= docSize.height || left + width <= 0 || top + height <= 0) continue
    plans.push({ ...layer, left, top, width, height })
  }
  return plans
}

/**
 * Resample an RGBA buffer with a separable tent filter. The filter widens when
 * shrinking so downscales average every source pixel instead of skipping most
 * of them (layer crops arrive ~4x larger than their box, so this is the common
 * case). Alpha is premultiplied during filtering to avoid dark fringes.
 */
function resizeRGBA(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src
  const pre = new Float32Array(sw * sh * 4)
  for (let i = 0; i < sw * sh; i++) {
    const a = src[i * 4 + 3] / 255
    pre[i * 4] = src[i * 4] * a
    pre[i * 4 + 1] = src[i * 4 + 1] * a
    pre[i * 4 + 2] = src[i * 4 + 2] * a
    pre[i * 4 + 3] = src[i * 4 + 3]
  }
  const horiz = resample1D(pre, sw, sh, dw, true)
  const both = resample1D(horiz, dw, sh, dh, false)

  const out = new Uint8Array(dw * dh * 4)
  for (let i = 0; i < dw * dh; i++) {
    const a = both[i * 4 + 3]
    out[i * 4 + 3] = clamp(a)
    if (a > 0.5) {
      const k = 255 / a
      out[i * 4] = clamp(both[i * 4] * k)
      out[i * 4 + 1] = clamp(both[i * 4 + 1] * k)
      out[i * 4 + 2] = clamp(both[i * 4 + 2] * k)
    }
  }
  return out
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

// One pass along x (horizontal=true) or y. `w`/`h` describe the input buffer;
// `dn` is the new length of the resampled axis.
function resample1D(src, w, h, dn, horizontal) {
  const sn = horizontal ? w : h
  const scale = dn / sn
  const support = scale < 1 ? 1 / scale : 1
  const outW = horizontal ? dn : w
  const outH = horizontal ? h : dn
  const out = new Float32Array(outW * outH * 4)

  // Precompute taps for each output position along the axis.
  const taps = new Array(dn)
  for (let d = 0; d < dn; d++) {
    const center = (d + 0.5) / scale - 0.5
    const lo = Math.max(0, Math.floor(center - support))
    const hi = Math.min(sn - 1, Math.ceil(center + support))
    const idx = []
    const wts = []
    let sum = 0
    for (let s = lo; s <= hi; s++) {
      const wt = Math.max(0, 1 - Math.abs(s - center) / support)
      if (wt > 0) {
        idx.push(s)
        wts.push(wt)
        sum += wt
      }
    }
    if (sum === 0) {
      idx.push(Math.min(sn - 1, Math.max(0, Math.round(center))))
      wts.push(1)
      sum = 1
    }
    taps[d] = { idx, wts: wts.map((x) => x / sum) }
  }

  const lines = horizontal ? h : w
  for (let line = 0; line < lines; line++) {
    for (let d = 0; d < dn; d++) {
      const { idx, wts } = taps[d]
      let r = 0, g = 0, b = 0, a = 0
      for (let t = 0; t < idx.length; t++) {
        const s = idx[t]
        const p = horizontal ? (line * w + s) * 4 : (s * w + line) * 4
        const wt = wts[t]
        r += src[p] * wt
        g += src[p + 1] * wt
        b += src[p + 2] * wt
        a += src[p + 3] * wt
      }
      const o = horizontal ? (line * outW + d) * 4 : (d * outW + line) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a
    }
  }
  return out
}

/**
 * Crop an RGBA buffer placed at (left, top) to the canvas. putPixels writes
 * whatever it is given, so anything hanging off the edge is trimmed here.
 */
function clipToCanvas(data, width, height, left, top, canvasW, canvasH) {
  const x0 = Math.max(0, left)
  const y0 = Math.max(0, top)
  const x1 = Math.min(canvasW, left + width)
  const y1 = Math.min(canvasH, top + height)
  const cw = x1 - x0
  const ch = y1 - y0
  if (cw <= 0 || ch <= 0) return null
  if (cw === width && ch === height) return { data, width, height, left, top }
  const out = new Uint8Array(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    const srcStart = ((y + y0 - top) * width + (x0 - left)) * 4
    out.set(data.subarray(srcStart, srcStart + cw * 4), y * cw * 4)
  }
  return { data: out, width: cw, height: ch, left: x0, top: y0 }
}

/** Long edge the upload is scaled to. Seedream's top tier is 2K. */
function uploadSize(docW, docH, maxEdge = 2048) {
  const long = Math.max(docW, docH)
  if (long <= maxEdge) return { width: docW, height: docH }
  const k = maxEdge / long
  return { width: Math.round(docW * k), height: Math.round(docH * k) }
}

module.exports = { planPlacement, resizeRGBA, clipToCanvas, uploadSize }
