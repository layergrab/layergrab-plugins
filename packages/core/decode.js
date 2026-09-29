// Decode a downloaded PNG or JPEG into a flat RGBA buffer. The API returns the
// base as JPEG and every layer as PNG with alpha; sniff the bytes rather than
// trust the URL extension.

const UPNG = require('./vendor/upng.js')
const decodeJpeg = require('./vendor/jpeg-decoder.js')

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
}

function isJpeg(bytes) {
  return bytes[0] === 0xff && bytes[1] === 0xd8
}

/** @returns {{ width: number, height: number, data: Uint8Array }} RGBA, 8-bit */
function decodeImage(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer)
  if (isPng(bytes)) {
    const img = UPNG.decode(arrayBuffer)
    const rgba = new Uint8Array(UPNG.toRGBA8(img)[0])
    return { width: img.width, height: img.height, data: rgba }
  }
  if (isJpeg(bytes)) {
    const img = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
    return { width: img.width, height: img.height, data: img.data }
  }
  throw new Error('Unsupported image format in API result.')
}

module.exports = { decodeImage }
