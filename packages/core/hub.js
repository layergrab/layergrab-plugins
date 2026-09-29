// LayerGrab account and split client for every plugin (Photoshop, Figma,
// Sketch, Chrome). Talks to backend-hub, the same backend as layergrab.com, so
// a plugin sees the same account, plan and credits as the website.
//
// Connecting uses the device authorization flow (docs/07): the plugin asks for
// a one-time code, opens layergrab.com/account/connect?code=… in the browser,
// the user signs in there (Google) and clicks Approve, and the plugin receives
// its own API key. Buying credits also happens on the website; the plugin just
// re-reads the balance.
//
// Pure CommonJS with no requires and no platform APIs: the only runtime
// dependency is a global `fetch`. Responses are read with res.json(), never
// res.text() (Sketch's fetch decodes text() as Latin-1).

const HUB_URL = 'https://api.layergrab.com'
const SITE_URL = 'https://layergrab.com'
// Public key that identifies the LayerGrab app to the hub (the prod app since
// 2026-09-28; pk_test_… is the sandbox app). The website uses the same one. It must match the website's, or approving a code fails with
// device.env_mismatch. Not a secret.
const APP_KEY = 'pk_live_1qPK4Oe2B4vVUKhMtbNWFVsG7ALBFngLR'

const POLL_MS = 3000
const MAX_SPLIT_MS = 8 * 60 * 1000
const CREDITS_PER_LAYER = { premium: 8, basic: 10 }

// ---------- errors ----------

const MESSAGES = {
  'credits.insufficient': 'You are out of credits. Buy credits on layergrab.com, then split again.',
  'credits.key_spend_limit': 'This connection has reached its spending limit.',
  'jobs.too_many_active': 'You already have a split running. Wait for it to finish.',
  'files.too_large': 'That image is too large. Use one under 20 MB.',
  'files.mime_not_allowed': 'Use a PNG or JPG image.',
  'files.upload_missing': 'The upload did not finish. Try again.',
  'files.size_mismatch': 'The upload did not finish. Try again.',
  'device.expired': 'The login code expired before it was approved. Log in again.',
  'device.not_found': 'The login code expired before it was approved. Log in again.',
  'jobs.unlock_expired': 'This split is more than 30 days old, so its layers are gone. Split the image again.',
}

const JOB_ERRORS = {
  upstream_error: 'The AI model could not split this image.',
  invalid_input: 'This image could not be used. Try one with clear, separate elements.',
  timeout: 'The split took too long and was stopped. Your credits were returned.',
  queue_timeout: 'The service was too busy to start your split. Try again in a few minutes.',
}

class HubError extends Error {
  constructor(status, body, fallback) {
    const code = (body && body.code) || `http.${status}`
    super(messageFor(code, status, fallback))
    this.name = 'HubError'
    this.status = status
    this.code = code
    this.params = (body && body.params) || {}
  }
}

function messageFor(code, status, fallback) {
  if (MESSAGES[code]) return MESSAGES[code]
  if (code === 'device.expired_token' || /expired/.test(code)) return MESSAGES['device.expired']
  if (status === 401 || status === 403) return 'You have been signed out of LayerGrab. Log in again.'
  if (status === 429) return 'Too many requests. Try again in a moment.'
  if (status >= 500) return 'LayerGrab is having trouble right now. Try again in a minute.'
  return fallback || 'Something went wrong. Try again.'
}

/** True when the saved key no longer works (revoked on the website, or expired). */
const isDisconnected = (e) => e instanceof HubError && (e.status === 401 || (e.status === 403 && /auth|api_key/.test(e.code)))
const isOutOfCredits = (e) => e instanceof HubError && e.code === 'credits.insufficient'

class CancelledError extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'CancelledError'
  }
}

/** Anything shaped like a key is masked before it can reach a dialog or a log. */
const redact = (text) => String(text).replace(/(sk|pk|dc)_[A-Za-z0-9_-]{8,}/g, '$1_••••')

// ---------- plumbing ----------

const aborted = (signal) => Boolean(signal && signal.aborted)
const realSignal = (signal) => (signal && typeof signal.addEventListener === 'function' ? signal : undefined)

/** Sleep in short steps so a plain `{ aborted }` flag (Sketch, Photoshop) cancels quickly too. */
async function sleep(ms, signal) {
  for (let left = ms; left > 0; left -= 250) {
    if (aborted(signal)) throw new CancelledError()
    await new Promise((r) => setTimeout(r, Math.min(250, left)))
  }
  if (aborted(signal)) throw new CancelledError()
}

function newId() {
  let s = ''
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16)
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`
}

/**
 * The init object for fetch, with no undefined keys and `signal` only when it
 * is a real AbortSignal. Figma's plugin fetch accepts only method, headers,
 * body (string or Uint8Array) and a few cache options, and rejects the
 * request outright when it sees anything else.
 */
function fetchInit(method, headers, body, signal) {
  const init = { method, headers }
  if (body !== undefined) init.body = body
  const real = realSignal(signal)
  if (real) init.signal = real
  return init
}

async function readJson(res) {
  try {
    return await res.json()
  } catch (e) {
    return {}
  }
}

async function request(path, opts) {
  const o = opts || {}
  const headers = { 'X-App-Key': APP_KEY, 'X-Locale': 'en' }
  if (o.body !== undefined) headers['Content-Type'] = 'application/json'
  if (o.key) headers.Authorization = `Bearer ${o.key}`
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey
  let res
  try {
    res = await fetch(`${HUB_URL}/v1${path}`, fetchInit(o.method || 'GET', headers, o.body === undefined ? undefined : JSON.stringify(o.body), o.signal))
  } catch (e) {
    if (aborted(o.signal)) throw new CancelledError()
    throw new Error(`Could not reach LayerGrab. Check your internet connection. (${redact((e && e.message) || e)})`)
  }
  const body = await readJson(res)
  if (!res.ok) throw new HubError(res.status, body)
  return body
}

// ---------- connecting an account ----------

/**
 * Ask for a one-time code. Open `url` in the browser: it carries the code, so
 * the user only signs in and clicks Approve. `userCode` is shown in the plugin
 * so it can be compared with the page, and typed in by hand if the browser
 * did not open.
 * @returns {{ deviceCode: string, userCode: string, url: string, expiresAt: number, interval: number }}
 */
async function startConnect(clientName) {
  const r = await request('/device/authorize', { method: 'POST', body: { client_name: clientName } })
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    url: connectUrl(r.user_code),
    expiresAt: Date.now() + (r.expires_in || 600) * 1000,
    interval: Math.max(2, r.interval || 3) * 1000,
  }
}

/**
 * Poll until the code is approved, then return the new API key (the hub hands
 * it out once). Throws CancelledError on cancel and HubError on expiry.
 * @param {(msLeft: number) => void} [onTick]
 */
async function waitForApproval(grant, opts) {
  const o = opts || {}
  for (;;) {
    if (Date.now() > grant.expiresAt) throw new HubError(410, { code: 'device.expired' })
    await sleep(grant.interval, o.signal)
    if (o.onTick) o.onTick(Math.max(0, grant.expiresAt - Date.now()))
    try {
      const r = await request('/device/token', { method: 'POST', body: { device_code: grant.deviceCode }, signal: o.signal })
      if (r.api_key) return r.api_key
    } catch (e) {
      if (e instanceof HubError && e.code === 'device.authorization_pending') continue
      if (e instanceof HubError && e.status === 429) continue
      if (e instanceof CancelledError) throw e
      if (!(e instanceof HubError)) continue // network blip: keep waiting
      throw e
    }
  }
}

// ---------- account ----------

/**
 * Who is connected and what they can spend. Called on open, after a split and
 * while the user is buying credits in the browser.
 * @returns {{ name: string, email: string, avatarUrl: string|null, credits: number, held: number, plan: 'premium'|'basic'|null, creditsPerLayer: number }}
 */
async function getAccount(key, signal) {
  const [me, wallet] = await Promise.all([request('/me', { key, signal }), request('/wallet', { key, signal })])
  const bal = (wallet.balances || []).find((b) => b.asset === 'credits') || {}
  const ents = (wallet.entitlements || []).map((e) => e.key)
  const plan = ents.indexOf('premium') >= 0 ? 'premium' : ents.indexOf('basic') >= 0 ? 'basic' : null
  return {
    name: me.display_name || (me.email ? me.email.split('@')[0] : 'Your account'),
    email: me.email || '',
    avatarUrl: me.avatar_url || null,
    credits: bal.available || 0,
    held: bal.held || 0,
    plan,
    creditsPerLayer: plan === 'premium' ? CREDITS_PER_LAYER.premium : CREDITS_PER_LAYER.basic,
  }
}

/**
 * Watch the balance after sending the user to buy credits: resolves with the
 * new account as soon as the credits or plan change, or null after `maxMs`.
 */
async function waitForPurchase(key, before, opts) {
  const o = opts || {}
  const end = Date.now() + (o.maxMs || 15 * 60 * 1000)
  while (Date.now() < end) {
    await sleep(o.intervalMs || 5000, o.signal)
    try {
      const now = await getAccount(key, o.signal)
      if (now.credits !== before.credits || now.plan !== before.plan) return now
    } catch (e) {
      if (e instanceof CancelledError || isDisconnected(e)) throw e
    }
  }
  return null
}

// ---------- links ----------

const connectUrl = (userCode) => `${SITE_URL}/account/connect?code=${encodeURIComponent(userCode)}`
/** `source` names the plugin (figma, photoshop, sketch, chrome) so the site can say "go back to Figma". */
const pricingUrl = (source) => `${SITE_URL}/pricing?from=${encodeURIComponent(source)}`
const accountUrl = (page) => `${SITE_URL}/account${page ? `/${page}` : ''}`

// ---------- splitting ----------

/**
 * Upload an image, run a layer split on the connected account, and return the
 * result in the same shape as api.parseResult, so pipeline.buildPixelLayers
 * and every plugin's placement code work unchanged.
 *
 * @param {object} o
 * @param {string} o.key
 * @param {Uint8Array|ArrayBuffer} o.bytes   PNG or JPEG
 * @param {'image/png'|'image/jpeg'} o.mime
 * @param {string} [o.filename]
 * @param {string} [o.hint]      what to separate; empty = every element
 * @param {{aborted:boolean}} [o.signal]
 * @param {(s: {phase: 'uploading'|'queued'|'splitting', elapsedMs: number}) => void} [o.onStatus]
 * @param {(url: string, headers: object, bytes: Uint8Array) => Promise<void>} [o.putBytes]  platform override for the upload PUT
 * @returns {SplitResult} a delivered result, or a locked one (`locked: true`, no urls) when the
 *   balance could not pay for everything the split returned; see unlock().
 */
async function split(o) {
  const started = Date.now()
  const status = (phase) => o.onStatus && o.onStatus({ phase, elapsedMs: Date.now() - started })
  const bytes = o.bytes instanceof Uint8Array ? o.bytes : new Uint8Array(o.bytes)
  const name = `${String(o.filename || 'image').replace(/\.[^.]*$/, '').slice(0, 120) || 'image'}.${o.mime === 'image/png' ? 'png' : 'jpg'}`

  status('uploading')
  const up = await request('/files', { method: 'POST', key: o.key, signal: o.signal, body: { purpose: 'layer_source', mime: o.mime, size_bytes: bytes.length, filename: name } })
  const put = o.putBytes || defaultPut
  await put(up.upload.url, up.upload.headers || {}, bytes, o.signal)
  if (aborted(o.signal)) throw new CancelledError()
  await request(`/files/${up.file_id}/complete`, { method: 'POST', key: o.key, signal: o.signal })

  status('queued')
  const prompt = String(o.hint || '').trim().slice(0, 500)
  const job = await runJob(o, 'layer.split', prompt ? { file_id: up.file_id, prompt } : { file_id: up.file_id }, status, started)
  if (job.status !== 'succeeded') {
    const code = job.error && job.error.code
    throw new Error(JOB_ERRORS[code] || 'The split failed. Your credits were returned.')
  }
  return jobToResult(job)
}

/**
 * Pay for a locked split and get all of its layers. The price was fixed when
 * the split ran (`result.unlockCost`); the hub charges it and hands over the
 * files in one step, and asking again returns the same result without a
 * second charge, so a retry after a network error is safe.
 *
 * @param {object} o
 * @param {string} o.key
 * @param {{jobId: string, unlockCost: number}} o.result   the locked result from split()
 * @param {{aborted:boolean}} [o.signal]
 * @returns {SplitResult} the delivered result
 * @throws {HubError} `credits.insufficient` (params.available / params.required) when the
 *   balance cannot pay; `jobs.unlock_expired` when the layers are gone (30 days).
 */
async function unlock(o) {
  let job
  try {
    job = await request(`/jobs/${o.result.jobId}/unlock`, { method: 'POST', key: o.key, signal: o.signal })
  } catch (e) {
    if (!(e instanceof HubError) || e.code !== 'jobs.not_locked') throw e
    job = await request(`/jobs/${o.result.jobId}`, { key: o.key, signal: o.signal }) // already unlocked
  }
  return { ...jobToResult(job), jobId: o.result.jobId }
}

/** Create a job and poll it to the end; cancelling stops it so its held credits are released. */
async function runJob(o, type, input, status, started) {
  let job = await request('/jobs', { method: 'POST', key: o.key, signal: o.signal, idempotencyKey: newId(), body: { type, input } })
  try {
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() - started > MAX_SPLIT_MS) throw new Error('The split is taking much longer than usual. Check layergrab.com/account/usage for the result later.')
      await sleep(POLL_MS, o.signal)
      try {
        job = await request(`/jobs/${job.id}`, { key: o.key, signal: o.signal })
      } catch (e) {
        if (e instanceof HubError || e instanceof CancelledError) throw e
        continue // network blip: keep polling
      }
      if (job.status === 'running') status('splitting')
      else if (job.status === 'queued') status('queued')
    }
  } catch (e) {
    if (e instanceof CancelledError) request(`/jobs/${job.id}/cancel`, { method: 'POST', key: o.key }).catch(() => {})
    throw e
  }
  if (job.status === 'canceled') throw new CancelledError()
  return job
}

async function defaultPut(url, headers, bytes, signal) {
  let res
  try {
    res = await fetch(url, fetchInit('PUT', headers, bytes, signal))
  } catch (e) {
    if (aborted(signal)) throw new CancelledError()
    throw new Error(`The upload failed. Check your connection and try again. (${redact((e && e.message) || e)})`)
  }
  if (!res.ok) throw new Error(`The upload failed (HTTP ${res.status}). Try again.`)
}

/**
 * @typedef {object} SplitResult
 * @property {string} jobId            the layer.split job
 * @property {number} charged
 * @property {boolean} [locked]        true: nothing delivered or charged yet; pay unlockCost to get the layers
 * @property {number} [unlockCost]
 * @property {string} [unlockExpiresAt]
 * @property {{url?: string, width: number, height: number}} base
 * @property {{url?: string, name: string, description: string, zIndex: number, box: number[]}[]} layers
 */

const toBox = (b) => [b.x, b.y, b.x + b.width, b.y + b.height]

/**
 * A finished layer.split job (delivered or locked) → SplitResult, boxes as
 * [x1, y1, x2, y2] in base pixels. A locked split has names and boxes but no files.
 */
function jobToResult(job) {
  const out = job.output
  if (!out) throw new Error('The split finished without a result.')
  // The hub decides whether the files are held back: after unlocking, `job.locked` turns false
  // while the runner's `output.locked` stays as it was.
  if (job.locked === true || (job.locked === undefined && out.locked)) {
    return {
      jobId: job.id,
      locked: true,
      charged: 0,
      unlockCost: job.lock_price || out.unlock_cost,
      unlockExpiresAt: job.unlock_expires_at || out.unlock_expires_at || null,
      sourceFileId: out.source_file_id || null,
      base: { width: out.base.width, height: out.base.height },
      layers: (out.layers || [])
        .filter((l) => l.bbox)
        .sort((a, b) => a.z_index - b.z_index)
        .map((l) => ({ name: l.name || `Layer ${l.z_index}`, description: l.description || '', zIndex: l.z_index, box: toBox(l.bbox) })),
    }
  }
  const urls = {}
  for (const f of job.outputs || []) urls[f.file_id] = f.url
  const baseUrl = urls[out.base.file_id]
  if (!baseUrl) throw new Error('The result files are no longer available.')
  const layers = (out.layers || [])
    .filter((l) => urls[l.file_id] && l.bbox)
    .sort((a, b) => a.z_index - b.z_index)
    .map((l) => ({
      url: urls[l.file_id],
      name: l.name || `Layer ${l.z_index}`,
      description: l.description || '',
      zIndex: l.z_index,
      box: toBox(l.bbox),
    }))
  return {
    jobId: job.id,
    charged: (job.cost && job.cost.charged) || out.charged || 0,
    base: { url: baseUrl, width: out.base.width, height: out.base.height },
    layers,
  }
}

// ---------- small helpers the plugins share ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** base64 (optionally a data: URL) → bytes. UXP and Sketch have no reliable atob. */
function base64ToBytes(input) {
  const s = String(input).replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63)
    out[o++] = (n >> 16) & 255
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255
    if (i + 3 < s.length) out[o++] = n & 255
  }
  return out.subarray(0, o)
}

/** "about 111 layers" from a balance. */
const layersFor = (account) => Math.floor(account.credits / account.creditsPerLayer)

module.exports = {
  unlock,
  HUB_URL,
  SITE_URL,
  APP_KEY,
  HubError,
  CancelledError,
  isDisconnected,
  isOutOfCredits,
  redact,
  startConnect,
  waitForApproval,
  getAccount,
  waitForPurchase,
  split,
  jobToResult,
  connectUrl,
  pricingUrl,
  accountUrl,
  base64ToBytes,
  layersFor,
}
