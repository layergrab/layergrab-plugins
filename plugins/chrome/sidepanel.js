// LayerGrab side panel. The account, credits and splits are the same as on
// layergrab.com: connecting uses the device flow in lib/hub.js (a tab opens on
// layergrab.com, the user signs in and approves), and buying credits happens
// on the website while this panel watches the balance.

const hub = window.module.exports
const $ = (id) => document.getElementById(id)

const KEY = 'layergrab-key'
const CLIENT_NAME = 'LayerGrab for Chrome'
const SOURCE = 'chrome'
const MAX_EDGE = 4096
const MAX_BYTES = 20 * 1024 * 1024
const DISCONNECTED = 'You were signed out from layergrab.com. Log in again to keep splitting.'

const SCREENS = ['loading', 'signedOut', 'connecting', 'home', 'work', 'result', 'failed']
function show(id) {
  SCREENS.forEach((s) => $(s).classList.toggle('hidden', s !== id))
  $('menuBtn').classList.toggle('hidden', !account || id === 'signedOut' || id === 'connecting')
  closeMenu()
}

function note(id, text, bad) {
  $(id).textContent = text || ''
  $(id).classList.toggle('hidden', !text)
  $(id).classList.toggle('bad', Boolean(bad))
}

const safe = (e) => hub.redact((e && e.message) || String(e))
const openTab = (url) => chrome.tabs.create({ url })
const mmss = (ms) => {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------- key ----------

const getKey = async () => (await chrome.storage.local.get(KEY))[KEY] || ''
const setKey = (key) => chrome.storage.local.set({ [KEY]: key })
const clearKey = () => chrome.storage.local.remove(KEY)

// ---------- account ----------

let account = null

function renderAccount() {
  if (!account) return
  $('credits').textContent = account.credits.toLocaleString('en-US')
  $('creditsSub').textContent = `about ${hub.layersFor(account)} layers`
  $('menuName').textContent = account.name
  $('menuEmail').textContent = account.email
  const av = $('avatarSm')
  av.textContent = (account.name || account.email || '?').trim().charAt(0).toUpperCase()
  if (account.avatarUrl) {
    const img = new Image()
    img.referrerPolicy = 'no-referrer'
    img.alt = ''
    img.onload = () => av.replaceChildren(img)
    img.src = account.avatarUrl
  }
}

async function signedOut(message) {
  await clearKey()
  account = null
  note('signedOutNote', message, /expired|trouble|reach/i.test(message || ''))
  $('connectBtn').disabled = false
  show('signedOut')
}

/** Re-read the account; `stay` keeps the current screen (used after a split). */
async function refreshAccount(stay) {
  const key = await getKey()
  if (!key) return signedOut()
  try {
    account = await hub.getAccount(key)
    renderAccount()
    note('homeNote', '')
  } catch (e) {
    if (hub.isDisconnected(e)) return signedOut(DISCONNECTED)
    note('homeNote', safe(e), true)
  }
  if (!stay) show('home')
}

// ---------- connecting ----------

let connectSignal = null

async function connect() {
  note('signedOutNote', '')
  $('connectBtn').disabled = true
  try {
    const grant = await hub.startConnect(CLIENT_NAME)
    // Kept for this browser session, so closing and reopening the panel while
    // the user approves picks the wait up again.
    await chrome.storage.session.set({ pendingConnect: grant })
    openTab(grant.url)
    await waitFor(grant)
  } catch (e) {
    signedOut(safe(e))
  }
}

async function waitFor(grant) {
  const signal = (connectSignal = { aborted: false })
  $('code').textContent = grant.userCode
  $('left').textContent = mmss(grant.expiresAt - Date.now())
  $('reopenBtn').onclick = () => openTab(grant.url)
  show('connecting')
  try {
    const key = await hub.waitForApproval(grant, { signal, onTick: (ms) => ($('left').textContent = mmss(ms)) })
    await setKey(key)
    await chrome.storage.session.remove('pendingConnect')
    await refreshAccount()
    note('homeNote', `Signed in as ${account ? account.email || account.name : 'your account'}.`)
    if (pendingSrc) pickFromUrl(pendingSrc)
  } catch (e) {
    await chrome.storage.session.remove('pendingConnect')
    if (e instanceof hub.CancelledError) return signedOut()
    signedOut(safe(e))
  } finally {
    connectSignal = null
  }
}

// ---------- buying credits ----------

let purchaseSignal = null

async function buy() {
  openTab(hub.pricingUrl(SOURCE))
  const key = await getKey()
  if (!key || !account) return
  if (purchaseSignal) purchaseSignal.aborted = true
  const signal = (purchaseSignal = { aborted: false })
  note('homeNote', 'Finish buying in the new tab. Your new balance shows up here on its own.')
  try {
    const next = await hub.waitForPurchase(key, account, { signal })
    if (next) {
      account = next
      renderAccount()
      note('homeNote', 'Your new balance is here. Thanks!')
    } else note('homeNote', '')
  } catch (e) {
    if (hub.isDisconnected(e)) signedOut(DISCONNECTED)
  }
}

// ---------- picking an image ----------

let picked = null // { blob, name, url }
let pendingSrc = null

function setPicked(blob, name) {
  if (picked) URL.revokeObjectURL(picked.url)
  picked = { blob, name: name || 'image', url: URL.createObjectURL(blob) }
  $('picked').src = picked.url
  $('picked').classList.remove('hidden')
  $('dropEmpty').classList.add('hidden')
  $('pickedName').textContent = picked.name
  $('pickedRow').classList.remove('hidden')
  $('splitBtn').disabled = false
  note('permNote', '')
  $('permBtn').classList.add('hidden')
}

function clearPicked() {
  if (picked) URL.revokeObjectURL(picked.url)
  picked = null
  $('picked').classList.add('hidden')
  $('picked').removeAttribute('src')
  $('dropEmpty').classList.remove('hidden')
  $('pickedRow').classList.add('hidden')
  $('splitBtn').disabled = true
}

const nameFromUrl = (u) => {
  try {
    const last = decodeURIComponent(new URL(u).pathname.split('/').pop() || '')
    return last && !u.startsWith('data:') ? last.slice(0, 120) : 'image'
  } catch (e) {
    return 'image'
  }
}

const ALL_SITES = { origins: ['<all_urls>'] }

/** An image the user right-clicked on a page. */
async function pickFromUrl(srcUrl) {
  if (!account) return
  show('home')
  if (srcUrl.startsWith('blob:')) return note('permNote', 'This image only exists inside that page. Save it, then drop it here.', true)
  try {
    const res = await fetch(srcUrl, { credentials: 'omit' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) throw new Error('not an image')
    setPicked(blob, nameFromUrl(srcUrl))
  } catch (e) {
    if (!(await chrome.permissions.contains(ALL_SITES))) {
      pendingSrc = srcUrl
      note('permNote', 'This site does not share its images with extensions. Allow LayerGrab to read images on websites, and it will try again. You can take this back in Chrome’s extension settings.')
      $('permBtn').classList.remove('hidden')
    } else note('permNote', 'This image could not be downloaded. Save it, then drop it here.', true)
  }
}

async function capture() {
  try {
    const win = await chrome.windows.getLastFocused()
    const dataUrl = await chrome.tabs.captureVisibleTab(win.id, { format: 'png' })
    const blob = await (await fetch(dataUrl)).blob()
    setPicked(blob, 'Screenshot')
  } catch (e) {
    pendingSrc = null
    note('permNote', 'Chrome only lets LayerGrab capture a tab after you click its toolbar button on that tab, or with permission to read websites.')
    $('permBtn').classList.remove('hidden')
  }
}

// The model takes PNG or JPEG up to 4096 px. Anything else, or anything
// larger, is redrawn: PNG when it has transparency, otherwise JPEG 0.92.
async function prepare(blob) {
  const bitmap = await createImageBitmap(blob).catch(() => null)
  if (!bitmap) throw new Error('This image could not be read. Try a PNG or JPG.')
  const long = Math.max(bitmap.width, bitmap.height)
  if (long <= MAX_EDGE && (blob.type === 'image/png' || blob.type === 'image/jpeg') && blob.size <= MAX_BYTES) {
    bitmap.close()
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type }
  }
  const scale = Math.min(1, MAX_EDGE / long)
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  let alpha = false
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { alpha = true; break }
  const out = await canvas.convertToBlob(alpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.92 })
  if (out.size > MAX_BYTES) throw new Error('This image is still over 20 MB after resizing. Try a smaller one.')
  return { bytes: new Uint8Array(await out.arrayBuffer()), mime: out.type }
}

// ---------- splitting ----------

let splitController = null

async function split() {
  if (!picked) return
  const key = await getKey()
  if (!key) return signedOut()
  splitController = new AbortController()
  const signal = splitController.signal
  $('workPreview').src = picked.url
  const status = (title, sub) => {
    $('workTitle').textContent = title
    $('workSub').textContent = sub || ''
  }
  status('Preparing the image…')
  show('work')
  try {
    const { bytes, mime } = await prepare(picked.blob)
    const result = await hub.split({
      key,
      bytes,
      mime,
      filename: picked.name,
      hint: $('hint').value,
      signal,
      onStatus: ({ phase, elapsedMs }) => {
        const s = Math.round(elapsedMs / 1000)
        if (phase === 'uploading') status('Uploading…', 'Sending the image to LayerGrab')
        else if (phase === 'queued') status(`Waiting for the AI model… ${s}s`, 'Usually about a minute in total. You can keep browsing.')
        else status(`Splitting into layers… ${s}s`, 'Usually about a minute. You can keep browsing; keep this panel open.')
      },
    })
    if (result.locked) showLocked(result, picked)
    else showResult(result, picked.name)
    refreshAccount(true)
  } catch (e) {
    if (e instanceof hub.CancelledError || signal.aborted) {
      show('home')
      note('homeNote', 'Cancelled. Nothing was charged.')
    } else if (hub.isDisconnected(e)) signedOut(DISCONNECTED)
    else {
      $('failTitle').textContent = hub.isOutOfCredits(e) ? 'Not enough credits' : 'Split failed'
      $('failSub').textContent = safe(e)
      $('failBuyBtn').classList.toggle('hidden', !hub.isOutOfCredits(e))
      show('failed')
      refreshAccount(true)
    }
  } finally {
    splitController = null
  }
}

// ---------- locked result ----------

// The balance did not cover everything the split returned, so nothing was
// delivered or charged (docs/08). Show where each layer is on the user's own
// image and offer to unlock all of them for the split's price.
let locked = null

const LOCK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'

function showLocked(result, image, message, bad, offerBuy) {
  locked = { result, image }
  const { base, layers } = result
  const total = layers.length + 1
  const cost = result.unlockCost.toLocaleString('en-US')
  const pct = (v, of) => `${(v / of) * 100}%`
  const stage = $('lockedStage')
  stage.replaceChildren()
  stage.style.aspectRatio = `${base.width} / ${base.height}`
  const img = new Image()
  img.src = image.url
  img.alt = 'Your image'
  Object.assign(img.style, { left: 0, top: 0, width: '100%', height: '100%' })
  stage.appendChild(img)
  const boxes = layers.map((l) => {
    const d = document.createElement('div')
    d.className = 'box'
    const [x1, y1, x2, y2] = l.box
    Object.assign(d.style, { left: pct(x1, base.width), top: pct(y1, base.height), width: pct(x2 - x1, base.width), height: pct(y2 - y1, base.height) })
    stage.appendChild(d)
    return d
  })
  $('lockedTitle').textContent = `Your image split into ${total} layers`
  $('lockedSub').textContent = `Your credits did not cover all of them, so none were delivered or charged. Unlock all ${total} for ${cost} credits.`
  $('unlockBtn').textContent = `Unlock ${total} layers · ${cost} credits`
  $('lockedBuyBtn').classList.toggle('hidden', !offerBuy)
  const list = $('lockedLayers')
  list.replaceChildren()
  layers
    .map((l, i) => ({ l, i }))
    .reverse()
    .forEach(({ l, i }) => {
      const li = document.createElement('li')
      const icon = document.createElement('span')
      icon.className = 'lock'
      icon.innerHTML = LOCK_ICON
      const name = document.createElement('span')
      name.className = 'lname'
      name.textContent = l.name
      li.append(icon, name)
      li.onclick = () => {
        list.querySelectorAll('li').forEach((x) => x.classList.remove('sel'))
        boxes.forEach((b) => b.classList.remove('sel'))
        li.classList.add('sel')
        boxes[i].classList.add('sel')
      }
      list.appendChild(li)
    })
  note('lockedNote', message || '', bad)
  show('locked')
}

async function unlock() {
  if (!locked || splitController) return // a second click while the first is in flight does nothing
  const { result, image } = locked
  splitController = new AbortController()
  const signal = splitController.signal
  $('unlockBtn').disabled = true
  try {
    const key = await getKey()
    if (!key) return signedOut()
    $('workPreview').src = image.url
    $('workTitle').textContent = 'Unlocking your layers…'
    $('workSub').textContent = 'Just a moment.'
    show('work')
    // One call: the hub charges the price fixed at split time and hands the files over.
    const unlocked = await hub.unlock({ key, result, signal })
    locked = null
    showResult(unlocked, image.name)
  } catch (e) {
    // Asking again after a cancel or a network error is safe: the hub returns the same result without a second charge.
    if (e instanceof hub.CancelledError || signal.aborted) showLocked(result, image, 'Cancelled.')
    else if (hub.isDisconnected(e)) signedOut(DISCONNECTED)
    else if (hub.isOutOfCredits(e)) {
      const have = e.params && e.params.available != null ? ` You have ${e.params.available.toLocaleString('en-US')}.` : ''
      showLocked(result, image, `Unlocking needs ${result.unlockCost.toLocaleString('en-US')} credits.${have} Buy credits on layergrab.com, then click Unlock again.`, true, true)
    } else if (e.code === 'jobs.unlock_expired') {
      locked = null // the hub has dropped the files; there is nothing left to unlock
      $('failTitle').textContent = 'These layers have expired'
      $('failSub').textContent = safe(e)
      $('failBuyBtn').classList.add('hidden')
      show('failed')
    } else showLocked(result, image, safe(e), true)
  } finally {
    splitController = null
    $('unlockBtn').disabled = false
    refreshAccount(true)
  }
}

// ---------- result ----------

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.7 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.2 3.2M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
}

const fileSafe = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'layer'
const extOf = (url, fallback) => {
  const m = /\.(png|jpe?g|webp)(?:$|\?)/i.exec(new URL(url).pathname)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : fallback
}

let current = null

function showResult(result, name) {
  current = { result, name: fileSafe(name.replace(/\.[^.]*$/, '')) }
  const { base, layers } = result
  const pct = (v, of) => `${(v / of) * 100}%`
  const stage = $('stage')
  stage.replaceChildren()
  stage.style.aspectRatio = `${base.width} / ${base.height}`
  const baseImg = new Image()
  baseImg.src = base.url
  baseImg.alt = 'Background with every element removed'
  Object.assign(baseImg.style, { left: 0, top: 0, width: '100%', height: '100%' })
  stage.appendChild(baseImg)
  const imgs = layers.map((l) => {
    const img = new Image()
    img.src = l.url
    img.alt = l.name
    const [x1, y1, x2, y2] = l.box
    Object.assign(img.style, { left: pct(x1, base.width), top: pct(y1, base.height), width: pct(x2 - x1, base.width), height: pct(y2 - y1, base.height) })
    stage.appendChild(img)
    return img
  })
  const hl = document.createElement('div')
  hl.className = 'hl hidden'
  stage.appendChild(hl)

  $('layerCount').textContent = `${layers.length + 1} layers`
  $('resultMeta').textContent = result.charged ? `${result.charged} credits used. Click a layer to find it; hide layers to see what is behind them.` : ''
  note('resultNote', '')

  const list = $('layers')
  list.replaceChildren()
  const select = (i) => {
    list.querySelectorAll('li').forEach((li) => li.classList.toggle('sel', Number(li.dataset.i) === i))
    const l = layers[i]
    if (!l) return hl.classList.add('hidden')
    const [x1, y1, x2, y2] = l.box
    Object.assign(hl.style, { left: pct(x1, base.width), top: pct(y1, base.height), width: pct(x2 - x1, base.width), height: pct(y2 - y1, base.height) })
    hl.classList.toggle('hidden', imgs[i].classList.contains('off'))
  }
  const row = (i, l, isBase) => {
    const li = document.createElement('li')
    li.dataset.i = String(i)
    const thumb = document.createElement('span')
    thumb.className = 'thumb checker'
    const t = new Image()
    t.src = isBase ? base.url : l.url
    t.alt = ''
    thumb.appendChild(t)
    const label = document.createElement('span')
    label.className = 'lname'
    label.textContent = isBase ? 'Background (filled)' : l.name
    li.append(thumb, label)
    const btn = (icon, title, fn) => {
      const b = document.createElement('button')
      b.className = 'lbtn'
      b.title = title
      b.setAttribute('aria-label', `${title}: ${label.textContent}`)
      b.innerHTML = ICONS[icon]
      b.onclick = (ev) => {
        ev.stopPropagation()
        fn(b)
      }
      li.appendChild(b)
    }
    if (!isBase) {
      btn('eye', 'Hide', (b) => {
        const off = imgs[i].classList.toggle('off')
        b.innerHTML = off ? ICONS.eyeOff : ICONS.eye
        b.title = off ? 'Show' : 'Hide'
        select(i)
      })
      btn('copy', 'Copy', () => copyLayer(l))
    }
    btn('download', 'Download', () => downloadOne(isBase ? { url: base.url, name: 'Background (filled)' } : l, isBase ? 0 : i + 1, isBase))
    li.onclick = () => !isBase && select(i)
    return li
  }
  // Top of the stack first, like a design tool's layer panel.
  for (let i = layers.length - 1; i >= 0; i--) list.appendChild(row(i, layers[i], false))
  list.appendChild(row(-1, null, true))
  select(layers.length - 1)
  show('result')
}

function downloadOne(l, n, isBase) {
  const ext = extOf(l.url, isBase ? 'jpg' : 'png')
  return chrome.downloads.download({ url: l.url, filename: `LayerGrab/${current.name}/${String(n).padStart(2, '0')} ${fileSafe(l.name)}.${ext}`, conflictAction: 'uniquify' })
}

async function downloadAll() {
  const { base, layers } = current.result
  await downloadOne({ url: base.url, name: 'Background (filled)' }, 0, true)
  for (let i = 0; i < layers.length; i++) await downloadOne(layers[i], i + 1, false)
  note('resultNote', `Saved ${layers.length + 1} files to Downloads/LayerGrab/${current.name}.`)
}

async function copyLayer(l) {
  try {
    let blob = await (await fetch(l.url)).blob()
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob)
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      c.getContext('2d').drawImage(bmp, 0, 0)
      blob = await c.convertToBlob({ type: 'image/png' })
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    note('resultNote', `Copied "${l.name}". Paste it into Figma, Photoshop, Canva or a document.`)
  } catch (e) {
    note('resultNote', 'Could not copy the layer. Use Download instead.', true)
  }
}

// ---------- menu ----------

function closeMenu() {
  $('menu').classList.add('hidden')
  $('menuBtn').setAttribute('aria-expanded', 'false')
}
$('menuBtn').onclick = (e) => {
  e.stopPropagation()
  const open = $('menu').classList.toggle('hidden') === false
  $('menuBtn').setAttribute('aria-expanded', String(open))
}
document.addEventListener('click', (e) => {
  if (!$('menu').contains(e.target)) closeMenu()
})
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu())
document.querySelectorAll('[data-open="usage"]').forEach((b) => (b.onclick = () => openTab(hub.accountUrl('usage'))))
$('disconnectBtn').onclick = () => signedOut('Signed out. To also remove this device from your account, visit layergrab.com/account/connect.')

// ---------- wiring ----------

$('connectBtn').onclick = connect
$('cancelConnectBtn').onclick = () => connectSignal && (connectSignal.aborted = true)
$('buyBtn').onclick = buy
$('failBuyBtn').onclick = () => (show('home'), buy())
$('failBackBtn').onclick = () => show('home')
$('splitBtn').onclick = split
$('cancelBtn').onclick = () => splitController && splitController.abort()
$('newBtn').onclick = () => (clearPicked(), show('home'))
$('unlockBtn').onclick = () => unlock()
$('lockedBuyBtn').onclick = () => (note('lockedNote', 'Finish buying in the new tab, then click Unlock.'), buy())
$('lockedNewBtn').onclick = () => ((locked = null), clearPicked(), show('home'))
$('downloadAllBtn').onclick = downloadAll
$('clearPick').onclick = (e) => (e.preventDefault(), clearPicked())
$('captureBtn').onclick = capture
$('permBtn').onclick = async () => {
  const ok = await chrome.permissions.request(ALL_SITES).catch(() => false)
  if (!ok) return
  $('permBtn').classList.add('hidden')
  note('permNote', '')
  if (pendingSrc) pickFromUrl(pendingSrc)
  else capture()
}
$('fileInput').onchange = (e) => {
  const f = e.target.files && e.target.files[0]
  if (f) setPicked(f, f.name)
  e.target.value = ''
}
const drop = $('drop')
drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')))
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const f = e.dataTransfer.files && e.dataTransfer.files[0]
  if (f && f.type.startsWith('image/')) return setPicked(f, f.name)
  // An image dragged straight from a web page arrives as a URL.
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
  if (url && /^(https?|data):/.test(url)) pickFromUrl(url.trim())
})
document.addEventListener('paste', (e) => {
  if ($('home').classList.contains('hidden')) return
  const f = Array.from((e.clipboardData && e.clipboardData.files) || []).find((x) => x.type.startsWith('image/'))
  if (f) setPicked(f, f.name || 'Pasted image')
})

// Right-clicked images arrive through session storage (background.js).
async function takePicked() {
  const { pickedImage } = await chrome.storage.session.get('pickedImage')
  if (!pickedImage) return
  await chrome.storage.session.remove('pickedImage')
  if (account) pickFromUrl(pickedImage.srcUrl)
  else pendingSrc = pickedImage.srcUrl
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pickedImage && changes.pickedImage.newValue) takePicked()
})

async function init() {
  const key = await getKey()
  const { pendingConnect } = await chrome.storage.session.get('pendingConnect')
  if (!key && pendingConnect && pendingConnect.expiresAt > Date.now()) waitFor(pendingConnect)
  else if (!key) signedOut()
  else {
    await refreshAccount()
    await takePicked()
    if (pendingSrc && account) pickFromUrl(pendingSrc)
  }
}

init()
