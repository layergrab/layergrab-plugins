// hub.js against a scripted fake of backend-hub: the connect flow, account
// info, a full split, out-of-credits, a revoked key and cancelling.

const test = require('node:test')
const assert = require('node:assert/strict')
const hub = require('../hub.js')

// setTimeout-based waits are the slow part; make them instant.
const realSetTimeout = global.setTimeout
global.setTimeout = (fn) => realSetTimeout(fn, 0)

function fakeHub(routes) {
  const calls = []
  global.fetch = async (url, init = {}) => {
    const method = init.method || 'GET'
    const path = url.replace(hub.HUB_URL + '/v1', '')
    calls.push({ method, path, headers: init.headers || {}, body: init.body })
    const handler = routes[`${method} ${path}`] || routes[`${method} ${path.split('?')[0]}`]
    if (!handler) throw new Error(`unexpected ${method} ${path}`)
    const [status, body] = typeof handler === 'function' ? handler(init, calls) : handler
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return calls
}

const job = (over) => ({ id: 'job1', type: 'layer.split', status: 'queued', output: null, outputs: [], cost: null, error: null, ...over })

test('connect: pending codes are polled until the key arrives', async () => {
  let polls = 0
  const calls = fakeHub({
    'POST /device/authorize': [200, { device_code: 'dc_abcdefghijklmnop', user_code: 'ABCD-EFGH', expires_in: 600, interval: 3 }],
    'POST /device/token': () => (++polls < 3 ? [428, { code: 'device.authorization_pending' }] : [200, { api_key: 'sk_test_u_secret' }]),
  })
  const grant = await hub.startConnect('LayerGrab for Figma')
  assert.equal(grant.userCode, 'ABCD-EFGH')
  assert.equal(grant.url, 'https://layergrab.com/account/connect?code=ABCD-EFGH')
  assert.equal(await hub.waitForApproval(grant), 'sk_test_u_secret')
  assert.equal(polls, 3)
  assert.equal(calls[0].headers['X-App-Key'], hub.APP_KEY)
  assert.deepEqual(JSON.parse(calls[0].body), { client_name: 'LayerGrab for Figma' })
})

test('connect: an expired code stops waiting with a clear message', async () => {
  fakeHub({ 'POST /device/token': [400, { code: 'device.expired_token' }] })
  await assert.rejects(hub.waitForApproval({ deviceCode: 'dc_x', expiresAt: Date.now() + 60000, interval: 1 }), /expired/)
  await assert.rejects(hub.waitForApproval({ deviceCode: 'dc_x', expiresAt: Date.now() - 1, interval: 1 }), /expired/)
})

test('connect: cancel stops the wait', async () => {
  fakeHub({ 'POST /device/token': [428, { code: 'device.authorization_pending' }] })
  const signal = { aborted: false }
  const p = hub.waitForApproval({ deviceCode: 'dc_x', expiresAt: Date.now() + 60000, interval: 1 }, { signal })
  signal.aborted = true
  await assert.rejects(p, hub.CancelledError)
})

test('account: name, email, credits and plan come from /me and /wallet', async () => {
  const calls = fakeHub({
    'GET /me': [200, { display_name: 'Ada', email: 'ada@example.com', avatar_url: 'https://x/a.png' }],
    'GET /wallet': [200, { balances: [{ asset: 'credits', available: 1110, held: 0 }], entitlements: [{ key: 'premium' }] }],
  })
  const a = await hub.getAccount('sk_test_u_secret')
  assert.deepEqual(a, { name: 'Ada', email: 'ada@example.com', avatarUrl: 'https://x/a.png', credits: 1110, held: 0, plan: 'premium', creditsPerLayer: 8 })
  assert.equal(hub.layersFor(a), 138)
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test_u_secret')
})

test('account: a revoked key reads as disconnected', async () => {
  fakeHub({ 'GET /me': [401, { code: 'auth.invalid_credentials' }], 'GET /wallet': [401, { code: 'auth.invalid_credentials' }] })
  const e = await hub.getAccount('sk_test_u_gone').catch((x) => x)
  assert.ok(hub.isDisconnected(e))
  assert.match(e.message, /signed out of LayerGrab/)
})

test('purchase: resolves when the balance changes', async () => {
  let n = 0
  fakeHub({
    'GET /me': [200, { email: 'ada@example.com' }],
    'GET /wallet': () => [200, { balances: [{ asset: 'credits', available: ++n < 3 ? 0 : 1800 }], entitlements: [] }],
  })
  const after = await hub.waitForPurchase('k', { credits: 0, plan: null }, { intervalMs: 1 })
  assert.equal(after.credits, 1800)
})

test('split: upload, job, polling and the result shape', async () => {
  let polls = 0
  const done = job({
    status: 'succeeded',
    cost: { asset: 'credits', held: 170, charged: 20 },
    output: {
      base: { file_id: 'fb', width: 2000, height: 1000 },
      layers: [
        { file_id: 'f2', name: 'Price Tag', description: 'tag', z_index: 2, bbox: { x: 10, y: 20, width: 100, height: 50 } },
        { file_id: 'f1', name: 'Headline', description: 'text', z_index: 1, bbox: { x: 0, y: 0, width: 500, height: 80 } },
      ],
      charged: 20,
    },
    outputs: [
      { file_id: 'fb', url: 'https://r2/base.jpg' },
      { file_id: 'f1', url: 'https://r2/1.png' },
      { file_id: 'f2', url: 'https://r2/2.png' },
    ],
  })
  const put = []
  const calls = fakeHub({
    'POST /files': [201, { file_id: 'src', upload: { method: 'PUT', url: 'https://r2/upload', headers: { 'Content-Type': 'image/png' } } }],
    'POST /files/src/complete': [200, {}],
    'POST /jobs': [201, job()],
    'GET /jobs/job1': () => [200, ++polls < 2 ? job({ status: 'running' }) : done],
  })
  const phases = []
  const r = await hub.split({
    key: 'k',
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/png',
    filename: 'Poster.final.png',
    hint: '  only the text ',
    onStatus: (s) => phases.push(s.phase),
    putBytes: async (url, headers, bytes) => put.push({ url, headers, n: bytes.length }),
  })
  assert.deepEqual(put, [{ url: 'https://r2/upload', headers: { 'Content-Type': 'image/png' }, n: 3 }])
  const files = JSON.parse(calls.find((c) => c.path === '/files').body)
  assert.deepEqual(files, { purpose: 'layer_source', mime: 'image/png', size_bytes: 3, filename: 'Poster.final.png' })
  const jobCall = calls.find((c) => c.path === '/jobs')
  assert.deepEqual(JSON.parse(jobCall.body), { type: 'layer.split', input: { file_id: 'src', prompt: 'only the text' } })
  assert.ok(jobCall.headers['Idempotency-Key'])
  assert.deepEqual(phases, ['uploading', 'queued', 'splitting'])
  assert.equal(r.charged, 20)
  assert.deepEqual(r.base, { url: 'https://r2/base.jpg', width: 2000, height: 1000 })
  assert.deepEqual(
    r.layers.map((l) => [l.name, l.zIndex, l.box]),
    [
      ['Headline', 1, [0, 0, 500, 80]],
      ['Price Tag', 2, [10, 20, 110, 70]],
    ],
  )
})

test('split: out of credits is recognisable', async () => {
  fakeHub({
    'POST /files': [201, { file_id: 'src', upload: { url: 'https://r2/upload' } }],
    'POST /files/src/complete': [200, {}],
    'POST /jobs': [402, { code: 'credits.insufficient' }],
  })
  const e = await hub.split({ key: 'k', bytes: new Uint8Array(1), mime: 'image/jpeg', putBytes: async () => {} }).catch((x) => x)
  assert.ok(hub.isOutOfCredits(e))
  assert.match(e.message, /out of credits/)
})

test('split: cancelling mid-run cancels the job so credits are released', async () => {
  const signal = { aborted: false }
  const calls = fakeHub({
    'POST /files': [201, { file_id: 'src', upload: { url: 'https://r2/upload' } }],
    'POST /files/src/complete': [200, {}],
    'POST /jobs': [201, job()],
    'GET /jobs/job1': () => ((signal.aborted = true), [200, job({ status: 'running' })]),
    'POST /jobs/job1/cancel': [200, job({ status: 'canceled' })],
  })
  await assert.rejects(hub.split({ key: 'k', bytes: new Uint8Array(1), mime: 'image/png', signal, putBytes: async () => {} }), hub.CancelledError)
  await new Promise((r) => realSetTimeout(r, 5))
  assert.ok(calls.some((c) => c.path === '/jobs/job1/cancel'))
})

test('split: a failed job explains itself', async () => {
  fakeHub({
    'POST /files': [201, { file_id: 'src', upload: { url: 'https://r2/upload' } }],
    'POST /files/src/complete': [200, {}],
    'POST /jobs': [201, job({ status: 'failed', error: { code: 'invalid_input' } })],
  })
  await assert.rejects(hub.split({ key: 'k', bytes: new Uint8Array(1), mime: 'image/png', putBytes: async () => {} }), /could not be used/)
})

const lockedJob = () =>
  job({
    status: 'succeeded',
    locked: true,
    lock_price: 40,
    unlock_expires_at: '2026-10-27T00:00:00Z',
    cost: { asset: 'credits', held: 30, charged: 0 },
    output: {
      locked: true,
      source_file_id: 'src',
      base: { file_id: 'fb', width: 2000, height: 1000 },
      layers: [
        { file_id: 'f2', name: 'Price Tag', description: 'tag', z_index: 2, bbox: { x: 10, y: 20, width: 100, height: 50 } },
        { file_id: 'f1', name: 'Headline', description: 'text', z_index: 1, bbox: { x: 0, y: 0, width: 500, height: 80 } },
        { file_id: 'f3', name: 'Cup', description: 'cup', z_index: 3, bbox: { x: 5, y: 5, width: 50, height: 50 } },
      ],
      layer_count: 4,
      unlock_cost: 40,
      unlock_expires_at: '2026-10-27T00:00:00Z',
      charged: 0,
    },
  })

test('split: a result the balance cannot pay for comes back locked, with names and boxes but no files', async () => {
  fakeHub({
    'POST /files': [201, { file_id: 'src', upload: { url: 'https://r2/upload' } }],
    'POST /files/src/complete': [200, {}],
    'POST /jobs': [201, lockedJob()],
  })
  const r = await hub.split({ key: 'k', bytes: new Uint8Array(1), mime: 'image/png', putBytes: async () => {} })
  assert.equal(r.locked, true)
  assert.equal(r.charged, 0)
  assert.equal(r.unlockCost, 40)
  assert.equal(r.unlockExpiresAt, '2026-10-27T00:00:00Z')
  assert.equal(r.sourceFileId, 'src')
  assert.deepEqual(r.base, { width: 2000, height: 1000 })
  assert.deepEqual(r.layers.map((l) => [l.name, l.box, l.url]), [
    ['Headline', [0, 0, 500, 80], undefined],
    ['Price Tag', [10, 20, 110, 70], undefined],
    ['Cup', [5, 5, 55, 55], undefined],
  ])
})

// After the hub hands the files over, the job flips to locked: false while the runner's output keeps its
// locked flag; the delivered files arrive in `outputs`.
const unlockedJob = () => ({
  ...lockedJob(),
  locked: false,
  unlocked_at: '2026-09-29T00:00:00Z',
  cost: { asset: 'credits', held: 30, charged: 40 },
  outputs: [
    { file_id: 'fb', url: 'https://r2/base.jpg' },
    { file_id: 'f1', url: 'https://r2/1.png' },
    { file_id: 'f2', url: 'https://r2/2.png' },
    { file_id: 'f3', url: 'https://r2/3.png' },
  ],
})

test('unlock: one call to the hub pays the fixed price and returns every layer under the original split', async () => {
  const calls = fakeHub({ 'POST /jobs/job1/unlock': [200, unlockedJob()] })
  const r = await hub.unlock({ key: 'k', result: { jobId: 'job1', unlockCost: 40 } })
  assert.deepEqual(calls.map((c) => c.path), ['/jobs/job1/unlock'])
  assert.equal(r.jobId, 'job1')
  assert.equal(r.locked, undefined)
  assert.equal(r.charged, 40)
  assert.equal(r.base.url, 'https://r2/base.jpg')
  assert.deepEqual(r.layers.map((l) => l.url), ['https://r2/1.png', 'https://r2/2.png', 'https://r2/3.png'])
})

test('unlock: the hub says the balance cannot pay', async () => {
  fakeHub({ 'POST /jobs/job1/unlock': [402, { code: 'credits.insufficient', params: { available: 30, required: 40 } }] })
  const e = await hub.unlock({ key: 'k', result: { jobId: 'job1', unlockCost: 40 } }).catch((x) => x)
  assert.ok(hub.isOutOfCredits(e))
  assert.deepEqual(e.params, { available: 30, required: 40 })
})

test('unlock: expired layers and an already-unlocked split', async () => {
  fakeHub({ 'POST /jobs/job1/unlock': [410, { code: 'jobs.unlock_expired' }] })
  await assert.rejects(hub.unlock({ key: 'k', result: { jobId: 'job1', unlockCost: 40 } }), /30 days old/)
  fakeHub({ 'POST /jobs/job1/unlock': [409, { code: 'jobs.not_locked' }], 'GET /jobs/job1': [200, unlockedJob()] })
  const r = await hub.unlock({ key: 'k', result: { jobId: 'job1', unlockCost: 40 } })
  assert.equal(r.charged, 40)
})

test('helpers: base64 decoding and redaction', () => {
  assert.deepEqual(Array.from(hub.base64ToBytes('data:image/png;base64,AAEC/w==')), [0, 1, 2, 255])
  assert.deepEqual(Array.from(hub.base64ToBytes('TWFu')), [77, 97, 110])
  assert.equal(hub.redact('key sk_test_u_abcdefghij failed'), 'key sk_•••• failed')
  assert.equal(hub.pricingUrl('figma'), 'https://layergrab.com/pricing?from=figma')
})
