// Figma plugin main thread. Connects the user's LayerGrab account (device
// authorization through layergrab.com), exports the selected node, splits it
// on that account's credits, and rebuilds the result as a group of
// image-filled rectangles directly above the original.

const hub = require('../../../packages/core/hub.js')
const { uploadScale } = require('../../../packages/core/layout.js')

const KEY_STORAGE = 'layergrab-key'
const CLIENT_NAME = 'LayerGrab for Figma'
const SOURCE = 'figma'
// Seedream's top tier is 2K; small frames are exported at up to 2x so the
// model has real detail to work with, and further when that is still under
// the model's minimum pixel count (see uploadScale).
const MAX_UPLOAD_EDGE = 2048

figma.showUI(__html__, { width: 320, height: 470, themeColors: true })

let splitSignal = null
let connectSignal = null
let purchaseSignal = null
let account = null

const post = (msg) => figma.ui.postMessage(msg)
const status = (text, sub, pct) => post({ type: 'status', text, sub: sub || '', pct })
const safeMessage = (e) => hub.redact((e && e.message) || String(e))

const readKey = async () => (await figma.clientStorage.getAsync(KEY_STORAGE)) || ''

async function signedOut(note) {
  await figma.clientStorage.deleteAsync(KEY_STORAGE)
  account = null
  post({ type: 'signed-out', note: note || '' })
}

/** Show the connected account, or the Connect screen if the key no longer works. */
async function showAccount() {
  const key = await readKey()
  if (!key) return post({ type: 'signed-out' })
  try {
    account = await hub.getAccount(key)
    post({ type: 'ready', account, layers: hub.layersFor(account) })
  } catch (e) {
    if (hub.isDisconnected(e)) return signedOut('You were signed out from layergrab.com. Log in again to keep splitting.')
    // Offline or the service is down: keep the key and let the user retry.
    post({ type: 'ready', account: null, error: safeMessage(e) })
  }
}

async function connect() {
  if (connectSignal) connectSignal.aborted = true
  const signal = (connectSignal = { aborted: false })
  try {
    const grant = await hub.startConnect(CLIENT_NAME)
    post({ type: 'connecting', code: grant.userCode, url: grant.url, msLeft: grant.expiresAt - Date.now() })
    figma.openExternal(grant.url)
    const key = await hub.waitForApproval(grant, { signal, onTick: (msLeft) => post({ type: 'connect-tick', msLeft }) })
    await figma.clientStorage.setAsync(KEY_STORAGE, key)
    await showAccount()
    figma.notify('Logged in to LayerGrab.')
  } catch (e) {
    if (e instanceof hub.CancelledError) return post({ type: 'signed-out' })
    post({ type: 'signed-out', note: safeMessage(e) })
  } finally {
    if (connectSignal === signal) connectSignal = null
  }
}

/** Send the user to the website to buy credits, and pick the new balance up as soon as it lands. */
async function buy() {
  figma.openExternal(hub.pricingUrl(SOURCE))
  const key = await readKey()
  if (!key || !account) return
  if (purchaseSignal) purchaseSignal.aborted = true
  const signal = (purchaseSignal = { aborted: false })
  post({ type: 'purchase-waiting' })
  try {
    const next = await hub.waitForPurchase(key, account, { signal })
    if (next) {
      account = next
      post({ type: 'ready', account, layers: hub.layersFor(account), note: 'Your new balance is here. Thanks!' })
    } else post({ type: 'purchase-stopped' })
  } catch (e) {
    if (hub.isDisconnected(e)) signedOut('You were signed out from layergrab.com. Log in again to keep splitting.')
    else post({ type: 'purchase-stopped' })
  }
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'connect') connect()
  else if (msg.type === 'cancel-connect') {
    if (connectSignal) connectSignal.aborted = true
  } else if (msg.type === 'open') figma.openExternal(msg.url)
  else if (msg.type === 'disconnect') signedOut('Signed out. To also remove this device from your account, visit layergrab.com/account/connect.')
  else if (msg.type === 'refresh') showAccount()
  else if (msg.type === 'buy') buy()
  else if (msg.type === 'unlock') {
    if (splitSignal) return // already in flight: the hub call is idempotent, but one placement is enough
    splitSignal = { aborted: false }
    try {
      await unlock(splitSignal)
    } catch (e) {
      if (hub.isDisconnected(e)) return signedOut('You were signed out from layergrab.com. Log in again to keep splitting.')
      const cancelled = e instanceof hub.CancelledError
      if (!locked) {
        // Paid and delivered; only adding the layers to the file stopped.
        post({ type: 'failed', text: cancelled ? 'Cancelled' : 'Unlocking failed', sub: cancelled ? UNLOCKED_NOTE : safeMessage(e) })
      } else if (cancelled) post(lockedMessage(locked.result, 'Cancelled.'))
      else if (hub.isOutOfCredits(e)) {
        const have = e.params && e.params.available != null ? ` You have ${e.params.available.toLocaleString('en-US')}.` : ''
        post({ ...lockedMessage(locked.result), type: 'failed', text: 'Not enough credits', sub: `Unlocking needs ${locked.result.unlockCost.toLocaleString('en-US')} credits.${have} Buy credits, then click Unlock again.`, outOfCredits: true, canUnlock: true })
      } else if (e.code === 'jobs.unlock_expired') {
        locked = null // the hub has dropped the files; there is nothing left to unlock
        post({ type: 'failed', text: 'These layers have expired', sub: safeMessage(e) })
      } else post({ ...lockedMessage(locked.result), type: 'failed', text: 'Unlocking failed', sub: safeMessage(e), canUnlock: true })
    } finally {
      splitSignal = null
      showAccount()
    }
  } else if (msg.type === 'split') {
    if (splitSignal) return
    locked = null
    splitSignal = { aborted: false }
    try {
      await split(msg.hint || '', splitSignal)
    } catch (e) {
      const cancelled = e instanceof hub.CancelledError
      if (hub.isDisconnected(e)) return signedOut('You were signed out from layergrab.com. Log in again to keep splitting.')
      post({ type: 'failed', text: cancelled ? 'Cancelled' : hub.isOutOfCredits(e) ? 'Not enough credits' : 'Split failed', sub: cancelled ? 'Nothing was charged.' : safeMessage(e), outOfCredits: hub.isOutOfCredits(e) })
    } finally {
      splitSignal = null
      showAccount()
    }
  } else if (msg.type === 'cancel') {
    if (splitSignal) splitSignal.aborted = true
    status('Cancelling…')
  } else if (msg.type === 'close') figma.closePlugin()
}

function isExportable(node) {
  return node && 'exportAsync' in node && 'width' in node && node.width > 0 && node.height > 0
}

async function split(hint, signal) {
  const key = await readKey()
  if (!key) return post({ type: 'signed-out' })
  const sel = figma.currentPage.selection
  if (sel.length !== 1 || !isExportable(sel[0])) {
    post({ type: 'failed', text: 'Select one image or frame', sub: 'Pick a single image, frame or group, then split again.' })
    return
  }
  const node = sel[0]
  const width = node.width
  const height = node.height
  const check = () => {
    if (signal.aborted) throw new hub.CancelledError()
  }

  status('Reading the image…', `"${node.name}", ${Math.round(width)} × ${Math.round(height)}`, 3)
  const scale = Math.max(0.1, uploadScale(width, height, { maxEdge: MAX_UPLOAD_EDGE, maxUp: 2 }))
  // WIDTH rather than SCALE: a tiny frame can need more than the largest scale factor export accepts.
  const png = await node.exportAsync({ format: 'PNG', constraint: { type: 'WIDTH', value: Math.max(1, Math.round(width * scale)) } })
  check()

  const result = await hub.split({
    key,
    bytes: png,
    mime: 'image/png',
    filename: node.name,
    hint,
    signal,
    onStatus: ({ phase, elapsedMs }) => {
      const s = Math.round(elapsedMs / 1000)
      if (phase === 'uploading') status('Uploading…', 'Sending the image to LayerGrab', 8)
      else if (phase === 'queued') status(`Waiting for the AI model… ${s}s`, 'Usually about a minute in total. You can keep working in Figma.', 12)
      else status(`Splitting into layers… ${s}s`, 'Usually about a minute. You can keep working in Figma.', 15 + 55 * Math.min(1, elapsedMs / 90000))
    },
  })
  check()
  if (result.locked) {
    locked = { result, node, width, height }
    return post(lockedMessage(result))
  }
  await place(result, node, width, height, check)
}

/** A split the balance could not pay for (docs/08): nothing delivered or charged yet. */
let locked = null

/** After a paid unlock the layers stay on the account, even when adding them to the file stops. */
const UNLOCKED_NOTE = 'Your layers are unlocked. Open them under Usage on layergrab.com/account/usage.'

function lockedMessage(result, note) {
  const total = result.layers.length + 1
  const cost = result.unlockCost.toLocaleString('en-US')
  return {
    type: 'locked',
    text: `Your image split into ${total} layers`,
    sub: `${note ? `${note} ` : ''}Your credits did not cover all of them, so none were added or charged. Unlock all ${total} for ${cost} credits.`,
    unlockLabel: `Unlock ${total} layers · ${cost} credits`,
  }
}

async function unlock(signal) {
  const key = await readKey()
  if (!key) return post({ type: 'signed-out' })
  if (!locked) return
  const { result, node, width, height } = locked
  if (node.removed) {
    locked = null
    return post({ type: 'failed', text: 'The image is gone', sub: 'The image you split was deleted from the file. Open the result under Usage on layergrab.com.' })
  }
  status('Unlocking your layers…', 'Just a moment.', 30)
  // One call: the hub charges the price fixed at split time and hands the files over.
  const unlocked = await hub.unlock({ key, result, signal })
  locked = null // paid from here on
  await place(unlocked, node, width, height, () => {
    if (signal.aborted) throw new hub.CancelledError()
  })
}

/** Download a delivered result and add it as the "LayerGrab" group above the node. */
async function place(result, node, width, height, check) {
  const total = result.layers.length + 1
  let done = 0
  // The split is done and paid for at this point; if a download fails, say
  // where the layers can still be opened rather than a bare "Failed to fetch".
  const saved = 'The layers were made, but could not be downloaded into Figma. Open them under Usage on layergrab.com/account/usage.'
  const fetchBytes = async (url) => {
    let res
    try {
      res = await fetch(url)
    } catch (e) {
      throw new Error(`${saved} (${hub.redact((e && e.message) || e)})`)
    }
    if (!res.ok) throw new Error(`${saved} (HTTP ${res.status})`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    done++
    status(`Downloading layers ${done} of ${total}…`, 'Almost done', 70 + 25 * (done / total))
    return bytes
  }
  status(`Downloading layers 0 of ${total}…`, 'Almost done', 70)
  const [baseBytes, ...layerBytes] = await Promise.all([result.base.url, ...result.layers.map((l) => l.url)].map(fetchBytes))
  check()

  // Boxes are in the base image's pixels; map them onto the node's size.
  const baseImage = figma.createImage(baseBytes)
  const baseSize = await baseImage.getSizeAsync()
  const sx = width / baseSize.width
  const sy = height / baseSize.height

  const imageRect = (name, image, x, y, w, h) => {
    const r = figma.createRectangle()
    r.name = name
    r.x = x
    r.y = y
    r.resize(Math.max(0.01, w), Math.max(0.01, h))
    r.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }]
    return r
  }

  // Place relative to the node inside its own parent, then group in place.
  const parent = node.parent
  const nodes = [imageRect('Background (filled)', baseImage, node.x, node.y, width, height)]
  result.layers.forEach((l, i) => {
    const [x1, y1, x2, y2] = l.box
    nodes.push(imageRect(l.name, figma.createImage(layerBytes[i]), node.x + x1 * sx, node.y + y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy))
  })
  nodes.forEach((n) => parent.appendChild(n))
  const group = figma.group(nodes, parent, parent.children.indexOf(node) + 1)
  group.name = 'LayerGrab'
  figma.currentPage.selection = [group]

  post({
    type: 'done',
    text: `Done — ${nodes.length} layers`,
    sub: `Added as the "LayerGrab" group above your image${result.charged ? `, ${result.charged} credits used` : ''}. Hide the group to compare with the original.`,
  })
}

showAccount()
