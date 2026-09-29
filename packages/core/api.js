// apimodels.app client for Seedream 5.0 Flash layer decomposition.
//
// Kept free of Photoshop APIs so it runs unchanged under Node for tests: the
// only runtime dependency is a global `fetch`, which both UXP and Node 18+ have.

const API_BASE = 'https://api.apimodels.app/v1/images/generations'
const MODEL = 'doubao-seedream-5-0-flash'

// Splits have finished in 58–83 s in testing; the ceiling leaves room for a
// busy upstream without leaving the panel spinning forever.
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 6 * 60 * 1000

class ApiError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** Human-readable message for the failures a user can act on. */
function describeFailure(status, body) {
  if (status === 401) return 'Your apimodels API key was rejected. Check it in Settings.'
  if (status === 402) return 'Your apimodels balance is too low for this split.'
  const msg = body && (body.msg || body.message || body.error)
  if (typeof msg === 'string' && /moderation|sensitive/i.test(msg)) {
    return 'The image was refused by the content filter.'
  }
  return typeof msg === 'string' && msg ? msg : `Request failed (HTTP ${status})`
}

// Uses res.json() rather than JSON.parse(await res.text()): Sketch's fetch
// polyfill decodes text() as Latin-1, which turned every Chinese layer name
// into mojibake, while its json() decodes UTF-8.
async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return { msg: `Unexpected response from apimodels.app (HTTP ${res.status})` }
  }
}

// Without an instruction the model names layers in Chinese ("黄色价格标签").
// The plugins are sold to English-speaking designers, and one sentence in the
// prompt is enough: tested 2026-09-27 on the banner fixture, every name and
// description came back in English ("Yellow Price Tag $129").
const NAMING = 'Write every layer name and description in English.'
const DEFAULT_SPLIT = 'Separate every main element onto its own layer.'

function buildPrompt(hint) {
  const h = (hint || '').trim()
  return h ? `${h.replace(/[.\s]+$/, '')}. ${NAMING}` : `${DEFAULT_SPLIT} ${NAMING}`
}

/**
 * Submit a split. Pass either `imageDataUrl` (a `data:image/jpeg;base64,...`
 * string — the API accepts base64 directly, which spares the plugins an upload
 * step) or `imageUrl` (an https address the API fetches itself — the runner
 * uses a presigned R2 link so the bytes never pass through its own slow uplink).
 */
async function createSplitTask({ apiKey, imageDataUrl, imageUrl, prompt, size = '2K' }) {
  const body = {
    model: MODEL,
    image_url: imageUrl || imageDataUrl,
    layer_decomposition: true,
    size,
  }
  body.prompt = buildPrompt(prompt)

  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await readJson(res)
  // This API can answer HTTP 200 with a non-200 `code` for some failures.
  const code = typeof json.code === 'number' ? json.code : res.status
  if (!res.ok || code !== 200) throw new ApiError(describeFailure(res.ok ? code : res.status, json), code)

  const taskId = json.data && (json.data.taskId || json.data.task_id)
  if (!taskId) throw new ApiError('The API did not return a task id.')
  return taskId
}

/**
 * Normalise a finished task into `{ base, layers }`. Layers come back sorted
 * bottom-to-top; each carries the pixel box it occupies in the base image.
 */
function parseResult(data) {
  let parsed = data.resultJson
  if (typeof parsed === 'string') parsed = JSON.parse(parsed)
  const all = (parsed && parsed.layers) || []
  const base = all.find((l) => l.role === 'base' || l.z_index === 0)
  if (!base || !base.url) throw new ApiError('The split came back without a base image.')

  const layers = all
    .filter((l) => l !== base && l.url && l.bounding_box && Array.isArray(l.bounding_box.absolute))
    .sort((a, b) => a.z_index - b.z_index)
    .map((l) => ({
      url: l.url,
      name: l.name || `Layer ${l.z_index}`,
      description: l.description || '',
      zIndex: l.z_index,
      box: l.bounding_box.absolute, // [x1, y1, x2, y2] in base-image pixels
    }))
  return { base: { url: base.url }, layers }
}

async function pollTask({ apiKey, taskId, onTick, signal }) {
  const started = Date.now()
  for (;;) {
    if (signal && signal.aborted) throw new ApiError('Cancelled.')
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      throw new ApiError('The split is taking unusually long. Try again in a minute.')
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    let json
    try {
      const res = await fetch(`${API_BASE}?task_id=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      json = await readJson(res)
      if (res.status === 401 || res.status === 402) throw new ApiError(describeFailure(res.status, json), res.status)
    } catch (e) {
      if (e instanceof ApiError) throw e
      continue // transient network blip — keep polling
    }

    const data = json.data || {}
    const state = String(data.state || data.status || '').toLowerCase()
    if (onTick) onTick(Date.now() - started, state)
    if (/success|completed/.test(state)) return parseResult(data)
    if (/fail|error/.test(state)) {
      throw new ApiError(describeFailure(200, { msg: data.failMsg || data.error || data.msg || 'The split failed.' }))
    }
  }
}

module.exports = { createSplitTask, pollTask, parseResult, buildPrompt, ApiError, MODEL }
