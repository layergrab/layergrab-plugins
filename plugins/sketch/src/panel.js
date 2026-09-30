// A small floating native panel that stays up for as long as something is
// happening: connecting the account in the browser, a split, or showing the
// account. Sketch's UI.message toast fades after a few seconds, and a menu
// item that seems to do nothing reads as "the plugin is broken".

const WIDTH = 380
const HEIGHT = 150
const GAP = 8

// AppKit constants, spelled out because Mocha does not expose all of them.
const STYLE_TITLED = 1
const STYLE_CLOSABLE = 1 << 1
const STYLE_UTILITY = 1 << 4
const BACKING_BUFFERED = 2
const SPINNING = 1

// The panel outlives the command's JS context once work is done, so the
// previous one is tracked on the main thread and closed when a new one opens.
const PANEL_KEY = 'com.layergrab.sketch.panel'

function closeStalePanel() {
  const dict = NSThread.mainThread().threadDictionary()
  const old = dict[PANEL_KEY]
  if (old) {
    old.close()
    dict.removeObjectForKey(PANEL_KEY)
  }
}

export function openUrl(url) {
  NSWorkspace.sharedWorkspace().openURL(NSURL.URLWithString(url))
}

/**
 * @param {string} title
 * @param {() => void} onClosed  runs when the panel goes away; the caller
 *   releases its fiber there, because button callbacks stop firing once the
 *   command's JavaScript context is torn down.
 */
export function createPanel(title, onClosed) {
  closeStalePanel()
  const panel = NSPanel.alloc().initWithContentRect_styleMask_backing_defer(
    NSMakeRect(0, 0, WIDTH, HEIGHT),
    STYLE_TITLED | STYLE_CLOSABLE | STYLE_UTILITY,
    BACKING_BUFFERED,
    false,
  )
  panel.setTitle(title)
  panel.setFloatingPanel(true)
  panel.setHidesOnDeactivate(false)
  panel.setReleasedWhenClosed(false)
  const content = panel.contentView()

  const spinner = NSProgressIndicator.alloc().initWithFrame(NSMakeRect(20, 94, 32, 32))
  spinner.setStyle(SPINNING)
  content.addSubview(spinner)

  const label = NSTextField.labelWithString('')
  label.setFont(NSFont.boldSystemFontOfSize(13))
  content.addSubview(label)

  const detail = NSTextField.wrappingLabelWithString('')
  detail.setFont(NSFont.systemFontOfSize(11))
  detail.setTextColor(NSColor.secondaryLabelColor())
  content.addSubview(detail)

  let buttons = []
  let closed = false
  let width = WIDTH
  let withSpinner = false

  const layout = () => {
    const left = withSpinner ? 66 : 20
    label.setFrame(NSMakeRect(left, 102, width - left - 20, 20))
    detail.setFrame(NSMakeRect(left, 46, width - left - 20, 54))
  }

  const close = () => {
    if (closed) return
    closed = true
    panel.close()
    NSThread.mainThread().threadDictionary().removeObjectForKey(PANEL_KEY)
    if (onClosed) onClosed()
  }

  const api = {
    get closed() {
      return closed
    },
    /** Title line, detail text, and whether the spinner shows. */
    set(text, sub, busy) {
      if (busy) {
        spinner.setHidden(false)
        spinner.startAnimation(null)
      } else {
        spinner.stopAnimation(null)
        spinner.setHidden(true)
      }
      withSpinner = Boolean(busy)
      layout()
      label.setStringValue(text || '')
      if (sub !== undefined) detail.setStringValue(sub || '')
    },
    /**
     * Right-aligned buttons, in order. `onClick` omitted = close. The panel
     * widens (and never clips a button) when the row needs more room.
     */
    buttons(list) {
      buttons.forEach((b) => b.removeFromSuperview())
      buttons = list.map((spec) => {
        const b = NSButton.buttonWithTitle_target_action(spec.title, null, null)
        b.sizeToFit()
        if (spec.primary) b.setKeyEquivalent('\r')
        b.setCOSJSTargetFunction(() => (spec.onClick ? spec.onClick() : close()))
        return { b, w: Math.max(80, Number(b.frame().size.width) + 12) }
      })
      const row = buttons.reduce((sum, { w }) => sum + w, 0) + GAP * (buttons.length - 1)
      const next = Math.max(WIDTH, row + 40)
      if (next !== width) {
        width = next
        panel.setContentSize(NSMakeSize(width, HEIGHT))
        layout()
      }
      let x = width - 20 - row
      buttons.forEach(({ b, w }) => {
        b.setFrame(NSMakeRect(x, 10, w, 28))
        x += w + GAP
        content.addSubview(b)
      })
      buttons = buttons.map(({ b }) => b)
    },
    close,
  }

  panel.center()
  panel.makeKeyAndOrderFront(null)
  NSThread.mainThread().threadDictionary()[PANEL_KEY] = panel
  return api
}
