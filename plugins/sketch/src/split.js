import sketch from 'sketch'
import UI from 'sketch/ui'
import { createFiber } from 'sketch/async'
import { createPanel, openUrl } from './panel'
import { DISCONNECTED, clearKey, hubClient, readKey, showAccountPanel } from './account'
import { avatarImage, rememberAccount, rememberedName } from './profile'

const { Group, Image, Rectangle } = sketch

// The upload's long edge. Seedream's top tier is 2K, and small layers are
// exported at up to 2x so the model has real detail to work from, and further
// when that is still under the model's minimum pixel count (see uploadScale).
const MAX_UPLOAD_EDGE = 2048

function exportScale(frame) {
  const { uploadScale } = require('../../../packages/core/layout.js')
  return Math.max(0.1, uploadScale(frame.width, frame.height, { maxEdge: MAX_UPLOAD_EDGE, maxUp: 2 }))
}

/**
 * Where the result goes. An artboard gets the group inside it at (0,0); any
 * other layer gets it as a sibling directly above, at the same position.
 */
function placementFor(layer) {
  if (layer.type === 'Artboard') {
    return { parent: layer, x: 0, y: 0, index: layer.layers.length }
  }
  return { parent: layer.parent, x: layer.frame.x, y: layer.frame.y, index: layer.index + 1 }
}

/**
 * Whether Sketch is drawing dark. Its own appearance comes first (Sketch can
 * force a theme); the system setting is the fallback.
 */
function isDarkMode() {
  try {
    return String(NSApplication.sharedApplication().effectiveAppearance().name()).indexOf('Dark') !== -1
  } catch (e) {
    try {
      return String(NSUserDefaults.standardUserDefaults().stringForKey('AppleInterfaceStyle')) === 'Dark'
    } catch (e2) {
      return false
    }
  }
}

const ACCOUNT_CODE = 1100

/**
 * A small "Account" button in the dialog's top-right corner, with the Google
 * picture of the signed-in account when there is one. It ends the dialog with
 * ACCOUNT_CODE, and the caller opens the account panel.
 */
function addAccountButton(alert) {
  try {
    alert.layout()
    const content = alert.window().contentView()
    const b = NSButton.buttonWithTitle_target_action('Account', null, null)
    b.setBordered(false)
    b.setFont(NSFont.systemFontOfSize(12))
    const avatar = avatarImage(18)
    try {
      b.setImage(avatar || NSImage.imageWithSystemSymbolName_accessibilityDescription('person.crop.circle', 'Account'))
      b.setImagePosition(2) // NSImageLeft
      if (!avatar) b.setContentTintColor(NSColor.secondaryLabelColor())
    } catch (e) {
      // macOS before 11: text only
    }
    const who = rememberedName()
    if (who) b.setToolTip(who)
    b.sizeToFit()
    const w = Number(b.frame().size.width) + 8
    const h = Number(b.frame().size.height)
    const bounds = content.bounds()
    const y = content.isFlipped() ? 12 : Number(bounds.size.height) - h - 12
    b.setFrame(NSMakeRect(Number(bounds.size.width) - w - 12, y, w, h))
    b.setCOSJSTargetFunction(() => NSApplication.sharedApplication().stopModalWithCode(ACCOUNT_CODE))
    content.addSubview(b)
  } catch (e) {
    // the dialog still works without it; signed-out runs open Account anyway
  }
}

/** Run a dialog: 'first' (its first button), 'account' or 'other'. */
function runDialog(alert) {
  const code = Number(alert.runModal())
  alert.window().orderOut(null)
  return code === 1000 ? 'first' : code === ACCOUNT_CODE ? 'account' : 'other'
}

/**
 * Ask what to separate. Returns { hint } (empty = every element), 'account'
 * when the Account button was clicked, or null when the user cancels. Same
 * 500-character limit as the other plugins.
 *
 * Not UI.getInputFromUser: its multi-line box has no border or fill, and in
 * dark mode it disappears into the dialog. This one is a tinted box in the
 * system accent colour, so it reads as a box in both appearances.
 */
function askHint(layerName) {
  const alert = NSAlert.alloc().init()
  alert.setMessageText(`Split "${layerName}" into layers`)
  alert.setInformativeText('What to separate? Leave it empty to separate every element. Credits are charged per layer you get.')
  alert.addButtonWithTitle('Split')
  alert.addButtonWithTitle('Cancel')
  try {
    const icon = __command.pluginBundle().alertIcon()
    if (icon) alert.setIcon(icon)
  } catch (e) {
    // the default app icon is fine
  }

  // The box is the system accent colour (what Sketch's own controls use) at
  // 10%, so it reads in light and dark mode alike; text and placeholder keep
  // the system colours of the current appearance. The field sits inset in a
  // layer-backed box, which gives the text padding and rounded corners.
  let accent
  try {
    accent = NSColor.controlAccentColor()
  } catch (e) {
    accent = NSColor.systemBlueColor() // macOS before 10.14
  }
  const W = 300
  const H = 64
  const PAD = 8
  const box = NSView.alloc().initWithFrame(NSMakeRect(0, 0, W, H))
  box.setWantsLayer(true)
  box.layer().setCornerRadius(6)
  box.layer().setBackgroundColor(accent.colorWithAlphaComponent(0.1).CGColor())
  box.layer().setBorderWidth(1)
  box.layer().setBorderColor(accent.colorWithAlphaComponent(0.6).CGColor())

  // Text colours are set for the current appearance, not left to the system:
  // on the tinted box the default placeholder grey disappears in dark mode.
  // Dark: light grey text and example. Light: dark grey.
  const dark = isDarkMode()
  const textColor = dark ? NSColor.colorWithWhite_alpha(0.92, 1) : NSColor.colorWithWhite_alpha(0.15, 1)
  const hintColor = dark ? NSColor.colorWithWhite_alpha(0.72, 1) : NSColor.colorWithWhite_alpha(0.4, 1)
  const font = NSFont.systemFontOfSize(13)

  const field = NSTextField.alloc().initWithFrame(NSMakeRect(PAD, PAD, W - 2 * PAD, H - 2 * PAD))
  field.setBezeled(false)
  field.setBordered(false)
  field.setDrawsBackground(false)
  field.setFocusRingType(1) // NSFocusRingTypeNone: the box's border is the focus cue
  field.setTextColor(textColor)
  field.setFont(font)
  field.cell().setWraps(true)
  field.cell().setScrollable(false)
  field.cell().setUsesSingleLineMode(false)
  box.addSubview(field)

  // The example goes in the box as a coloured placeholder. Mocha has no
  // alloc().initWithString… on attributed strings (Sketch 2025.1), but
  // NSMutableAttributedString.new() plus replaceCharactersInRange works there;
  // the second construction and the label under the box are fallbacks.
  const example = 'e.g. only the headline and the product'
  const colouredPlaceholder = [
    () => {
      const s = NSMutableAttributedString.new()
      s.replaceCharactersInRange_withString(NSMakeRange(0, 0), example)
      return s
    },
    () => {
      const s = NSMutableAttributedString.alloc().init()
      s.mutableString().setString(example)
      return s
    },
  ].reduce((found, make) => {
    if (found) return found
    try {
      const s = make()
      const all = NSMakeRange(0, s.length())
      s.addAttribute_value_range('NSColor', hintColor, all) // NSForegroundColorAttributeName
      s.addAttribute_value_range('NSFont', font, all) // NSFontAttributeName
      return s
    } catch (e) {
      return null
    }
  }, null)

  let accessory = box
  if (colouredPlaceholder) {
    field.setPlaceholderAttributedString(colouredPlaceholder)
  } else {
    const LABEL_H = 20
    accessory = NSView.alloc().initWithFrame(NSMakeRect(0, 0, W, H + 6 + LABEL_H))
    box.setFrameOrigin(NSMakePoint(0, LABEL_H + 6))
    const label = NSTextField.labelWithString(example)
    label.setFont(NSFont.systemFontOfSize(12))
    label.setTextColor(hintColor)
    label.setFrame(NSMakeRect(2, 0, W - 4, LABEL_H))
    accessory.addSubview(box)
    accessory.addSubview(label)
  }
  alert.setAccessoryView(accessory)
  alert.window().setInitialFirstResponder(field)

  addAccountButton(alert)

  const choice = runDialog(alert)
  if (choice === 'account') return 'account'
  if (choice !== 'first') return null
  return { hint: String(field.stringValue() || '').trim().slice(0, 500) }
}

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not download a layer (HTTP ${res.status}).`)
  return res.blob() // NSData — Sketch's Image takes it as-is
}

export default function onSplit() {
  const hub = hubClient()
  if (!readKey()) return showAccountPanel('Log in to split images.')
  const fiber = createFiber()
  // Refresh the name and picture shown in the dialog corner (for next time
  // if it arrives after the dialog is up). A removed connection is handled
  // by the split itself.
  const refresh = hub.getAccount(readKey()).then(rememberAccount, () => {})
  let panel = null
  // Keep the fiber alive while the panel is up: its buttons are JS callbacks
  // and die with the context. Released when the panel closes, or straight
  // away if the run ended before a panel was shown.
  const release = () => fiber.cleanup()
  const state = { aborted: false, refresh }
  run((p) => (panel = p), release, state)
    .catch((e) => {
      const msg = hub.redact((e && e.message) || String(e))
      if (hub.isDisconnected(e)) {
        clearKey()
        if (panel) panel.close()
        return showAccountPanel(DISCONNECTED)
      }
      if (!panel) return UI.alert('LayerGrab', msg)
      const cancelled = e instanceof hub.CancelledError
      panel.set(cancelled ? 'Cancelled' : hub.isOutOfCredits(e) ? 'Not enough credits' : 'Split failed', cancelled ? 'Nothing was charged.' : msg, false)
      panel.buttons(
        hub.isOutOfCredits(e)
          ? [{ title: 'Close' }, { title: 'Buy credits', primary: true, onClick: () => (panel.close(), showAccountPanel()) }]
          : [{ title: 'Close', primary: true }],
      )
    })
    .then(() => {
      if (!panel) release()
    })
}

async function run(setPanel, onPanelClosed, state) {
  const hub = hubClient()
  const key = readKey()

  const doc = sketch.getSelectedDocument()
  const selected = doc ? doc.selectedLayers.layers : []
  if (selected.length !== 1) {
    const alert = NSAlert.alloc().init()
    alert.setMessageText('Select an image to split')
    alert.setInformativeText('Select one image, group or artboard on the canvas, then run LayerGrab again.')
    alert.addButtonWithTitle('OK')
    addAccountButton(alert)
    if (runDialog(alert) === 'account') showAccountPanel()
    return
  }
  const layer = selected[0]
  const frame = layer.frame
  // First run on this Mac: nothing remembered yet, so give the account a
  // moment to load and the corner shows the picture from the start.
  if (!rememberedName()) await Promise.race([state.refresh, new Promise((r) => setTimeout(r, 2500))])
  const answer = askHint(layer.name)
  if (answer === 'account') return showAccountPanel()
  if (!answer) return
  const { hint } = answer

  const panel = createPanel('LayerGrab', onPanelClosed)
  setPanel(panel)
  const signal = {
    get aborted() {
      return state.aborted || panel.closed
    },
  }
  const progress = (text, sub) => panel.set(text, sub, true)
  panel.buttons([{ title: 'Cancel', onClick: () => ((state.aborted = true), progress('Cancelling…')) }])
  const checkCancel = () => {
    if (signal.aborted) throw new hub.CancelledError()
  }

  progress('Reading the image…', `"${layer.name}", ${Math.round(frame.width)} × ${Math.round(frame.height)}${hint ? ` · ${hint}` : ''}`)
  const png = sketch.export(layer, { formats: 'png', output: false, scales: String(exportScale(frame)) })

  const result = await hub.split({
    key,
    bytes: png,
    mime: 'image/png',
    filename: layer.name,
    hint,
    signal,
    // Sketch's fetch sends a Buffer body as raw bytes.
    putBytes: async (url, headers, bytes) => {
      const res = await fetch(url, { method: 'PUT', headers, body: Buffer.from(bytes) })
      if (!res.ok) throw new Error(`The upload failed (HTTP ${res.status}). Try again.`)
    },
    onStatus: ({ phase, elapsedMs }) => {
      const s = Math.round(elapsedMs / 1000)
      if (phase === 'uploading') progress('Uploading…', 'Sending the image to LayerGrab')
      else if (phase === 'queued') progress(`Waiting for the AI model… ${s}s`, 'Usually about a minute in total. You can keep working in Sketch.')
      else progress(`Splitting into layers… ${s}s`, 'Usually takes about a minute. You can keep working in Sketch.')
    },
  })
  checkCancel()
  if (result.locked) return showLocked({ hub, key, panel, result, place: (r) => place(r, { layer, frame, doc, progress, checkCancel, panel }) })
  await place(result, { layer, frame, doc, progress, checkCancel, panel })
}

/**
 * The balance could not pay for everything the split returned, so nothing was
 * delivered or charged (docs/08). Say how many layers there are and what
 * unlocking them costs; Unlock pays and places them like a normal result.
 */
function showLocked({ hub, key, panel, result, place }) {
  const total = result.layers.length + 1
  const cost = result.unlockCost.toLocaleString('en-US')
  const offer = (note) => {
    panel.set(
      `Your image split into ${total} layers`,
      `${note ? `${note}\n` : ''}Your credits did not cover all of them, so none were added or charged. Unlock all ${total} for ${cost} credits.`,
      false,
    )
    panel.buttons([{ title: 'Close' }, { title: `Unlock ${total} layers · ${cost} credits`, primary: true, onClick: () => unlockNow() }])
  }
  const unlockNow = async () => {
    const state = { aborted: false }
    const signal = { get aborted() { return state.aborted || panel.closed } }
    const progress = (text, sub) => panel.set(text, sub, true)
    // Replacing the buttons first means a second click cannot start another unlock.
    panel.buttons([{ title: 'Cancel', onClick: () => ((state.aborted = true), progress('Cancelling…')) }])
    let paid = false
    try {
      progress('Unlocking your layers…', 'Just a moment.')
      // One call: the hub charges the price fixed at split time and hands the files over.
      const unlocked = await hub.unlock({ key, result, signal })
      paid = true
      await place(unlocked)
    } catch (e) {
      if (panel.closed) return
      if (hub.isDisconnected(e)) {
        clearKey()
        panel.close()
        return showAccountPanel(DISCONNECTED)
      }
      const msg = hub.redact((e && e.message) || String(e))
      if (paid) {
        // Paid and delivered; only adding the layers to the document stopped.
        const cancelled = e instanceof hub.CancelledError
        panel.set(cancelled ? 'Cancelled' : 'Could not add the layers', `${cancelled ? '' : `${msg} `}Your layers are unlocked. Open them under Usage on layergrab.com/account/usage.`, false)
        panel.buttons([{ title: 'Close', primary: true }])
        return
      }
      if (e instanceof hub.CancelledError) return offer('Cancelled.')
      if (e.code === 'jobs.unlock_expired') {
        // The hub has dropped the files; there is nothing left to unlock.
        panel.set('These layers have expired', msg, false)
        panel.buttons([{ title: 'Close', primary: true }])
        return
      }
      if (hub.isOutOfCredits(e)) {
        const have = e.params && e.params.available != null ? ` You have ${e.params.available.toLocaleString('en-US')}.` : ''
        panel.set('Not enough credits', `Unlocking needs ${cost} credits.${have} Buy credits on layergrab.com, then click Unlock again.`, false)
        panel.buttons([
          { title: 'Close' },
          { title: 'Unlock', onClick: () => unlockNow() },
          { title: 'Buy credits', primary: true, onClick: () => openUrl(hub.pricingUrl('sketch')) },
        ])
        return
      }
      offer(msg)
    }
  }
  offer()
}

/** Download a delivered result and add it as the "LayerGrab" group above the image. */
async function place(result, { layer, frame, doc, progress, checkCancel, panel }) {
  // Boxes are in the base image's pixels; the layer's frame is in points.
  // Downloading the base first gives its pixel size, so every box maps by the
  // same factor regardless of the export scale or the model's output size.
  const total = result.layers.length + 1
  let downloaded = 0
  const tick = () => progress(`Downloading layers ${++downloaded} of ${total}…`, 'Almost done')
  progress(`Downloading layers 0 of ${total}…`, 'Almost done')
  const baseData = await download(result.base.url)
  tick()
  const baseImage = NSImage.alloc().initWithData(baseData)
  const rep = baseImage.representations().firstObject()
  const basePxW = Number(rep.pixelsWide())
  const basePxH = Number(rep.pixelsHigh())
  const sx = frame.width / basePxW
  const sy = frame.height / basePxH

  const layerData = await Promise.all(result.layers.map((l) => download(l.url).then((d) => (tick(), d))))
  checkCancel()

  const children = [
    new Image({
      name: 'Background (filled)',
      image: baseData,
      frame: new Rectangle(0, 0, frame.width, frame.height),
    }),
  ]
  result.layers.forEach((l, i) => {
    const [x1, y1, x2, y2] = l.box
    children.push(
      new Image({
        name: l.name,
        image: layerData[i],
        frame: new Rectangle(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy),
      }),
    )
  })

  const target = placementFor(layer)
  const group = new Group({
    name: 'LayerGrab',
    parent: target.parent,
    frame: new Rectangle(target.x, target.y, frame.width, frame.height),
    layers: children, // first = bottom, so the background sits under everything
  })
  group.index = target.index
  group.adjustToFit()
  doc.selectedLayers.clear()
  group.selected = true

  panel.set(
    `Done — ${children.length} layers`,
    `Added as the "LayerGrab" group above your image${result.charged ? `, ${result.charged} credits used` : ''}. Hide the group to compare with the original.`,
    false,
  )
  panel.buttons([{ title: 'Close', primary: true }])
}
