const test = require('node:test')
const assert = require('node:assert/strict')
const { planPlacement, resizeRGBA, clipToCanvas, uploadSize } = require('../layout.js')

test('planPlacement scales boxes from base pixels to document pixels', () => {
  // Base came back at 2x the document, as in the poster test.
  const plans = planPlacement(
    [{ name: 'badge', box: [1200, 615, 1674, 1088] }],
    { width: 1760, height: 2368 },
    { width: 880, height: 1184 },
  )
  assert.deepEqual(
    { left: plans[0].left, top: plans[0].top, width: plans[0].width, height: plans[0].height },
    { left: 600, top: 308, width: 237, height: 237 },
  )
})

test('planPlacement drops layers entirely outside the canvas', () => {
  const plans = planPlacement(
    [{ name: 'off', box: [3000, 10, 3100, 20] }],
    { width: 1000, height: 1000 },
    { width: 1000, height: 1000 },
  )
  assert.equal(plans.length, 0)
})

test('resizeRGBA keeps a solid colour solid when shrinking 4x', () => {
  const sw = 40, sh = 20
  const src = new Uint8Array(sw * sh * 4)
  for (let i = 0; i < sw * sh; i++) src.set([200, 100, 50, 255], i * 4)
  const out = resizeRGBA(src, sw, sh, 10, 5)
  assert.equal(out.length, 10 * 5 * 4)
  for (let i = 0; i < 50; i++) assert.deepEqual([...out.subarray(i * 4, i * 4 + 4)], [200, 100, 50, 255])
})

test('resizeRGBA does not bleed black into edges of transparent regions', () => {
  // Left half opaque red, right half fully transparent black. A naive
  // (non-premultiplied) filter would darken the red at the boundary.
  const sw = 8, sh = 2
  const src = new Uint8Array(sw * sh * 4)
  for (let y = 0; y < sh; y++) for (let x = 0; x < 4; x++) src.set([255, 0, 0, 255], (y * sw + x) * 4)
  const out = resizeRGBA(src, sw, sh, 4, 1)
  for (let x = 0; x < 4; x++) {
    const a = out[x * 4 + 3]
    if (a > 0) assert.equal(out[x * 4], 255, `pixel ${x} red channel darkened`)
  }
})

test('clipToCanvas trims a layer hanging off the top-left corner', () => {
  const w = 4, h = 4
  const data = new Uint8Array(w * h * 4).map((_, i) => i % 256)
  const c = clipToCanvas(data, w, h, -1, -2, 100, 100)
  assert.deepEqual({ w: c.width, h: c.height, l: c.left, t: c.top }, { w: 3, h: 2, l: 0, t: 0 })
  // First kept pixel is source (x=1, y=2).
  assert.equal(c.data[0], data[(2 * w + 1) * 4])
})

test('uploadSize caps the long edge at 2048 and keeps aspect', () => {
  assert.deepEqual(uploadSize(6000, 4000), { width: 2048, height: 1365 })
  assert.deepEqual(uploadSize(880, 1184), { width: 880, height: 1184 })
})
