import Settings from 'sketch/settings'
import { createFiber } from 'sketch/async'
import { setTimeout as skpmSetTimeout } from '@skpm/timers/timeout'
import { createPanel, openUrl } from './panel'
import { forgetAccount, rememberAccount } from './profile'

// hub.js waits with setTimeout; Sketch's runtime does not guarantee one.
if (typeof globalThis.setTimeout !== 'function') globalThis.setTimeout = skpmSetTimeout

const KEY_NAME = 'layergrab-key'
const CLIENT_NAME = 'LayerGrab for Sketch'
const SOURCE = 'sketch'
const DISCONNECTED = 'You were signed out from layergrab.com. Log in again to keep splitting.'

// Required lazily so a load failure reaches a dialog instead of dying silently.
export const hubClient = () => require('../../../packages/core/hub.js')

/**
 * The saved key. Settings.settingForKey JSON-parses the stored value and its
 * parse error quotes the raw value, which is the key itself; that error must
 * never reach a dialog, so it is swallowed and the raw string read directly.
 */
export function readKey() {
  try {
    const v = Settings.settingForKey(KEY_NAME)
    if (typeof v === 'string' && v.trim()) return v.trim()
  } catch (e) {
    // fall through — never rethrow, the message contains the key
  }
  try {
    const id = __command.pluginBundle().identifier()
    const raw = NSUserDefaults.alloc().initWithSuiteName(`plugin.sketch.${id}`).stringForKey(KEY_NAME)
    return raw ? String(raw).replace(/^"|"$/g, '').trim() : ''
  } catch (e) {
    return ''
  }
}

// Stored in Sketch's plugin settings (this Mac's user defaults). The key only
// splits images on the user's own credits and can be removed from the website.
const saveKey = (key) => Settings.setSettingForKey(KEY_NAME, key)
const clearKey = () => {
  Settings.setSettingForKey(KEY_NAME, '')
  forgetAccount()
}

const mmss = (ms) => {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const creditLine = (hub, a) => `${a.credits.toLocaleString('en-US')} credits · about ${hub.layersFor(a)} layers`

/**
 * Show the account panel: the Connect screen when there is no key, otherwise
 * who is signed in, the balance, Buy credits and Sign out. `reason` is a
 * line shown on the Connect screen (e.g. why the split needs an account).
 */
export function showAccountPanel(reason) {
  const fiber = createFiber()
  const panel = createPanel('LayerGrab', () => fiber.cleanup())
  accountView(panel, reason).catch((e) => {
    panel.set('Something went wrong', hubClient().redact((e && e.message) || String(e)), false)
    panel.buttons([{ title: 'Close' }])
  })
}

async function accountView(panel, note) {
  const hub = hubClient()
  const key = readKey()
  if (!key) return connectView(panel, note)
  panel.set('Loading your account…', '', true)
  panel.buttons([{ title: 'Close' }])
  let account
  try {
    account = await hub.getAccount(key)
  } catch (e) {
    if (hub.isDisconnected(e)) {
      clearKey()
      return connectView(panel, DISCONNECTED)
    }
    panel.set('Could not load your account', hub.redact(e.message), false)
    panel.buttons([{ title: 'Try again', onClick: () => accountView(panel) }, { title: 'Close', primary: true }])
    return
  }
  rememberAccount(account)
  const render = (msg) => {
    panel.set(account.email ? `${account.name} · ${account.email}` : account.name, `${creditLine(hub, account)}${msg ? `\n${msg}` : ''}`, false)
    panel.buttons([
      { title: 'Sign out', onClick: () => (clearKey(), connectView(panel, 'Signed out. To also remove this device from your account, visit layergrab.com/account/connect.')) },
      { title: 'Usage', onClick: () => openUrl(hub.accountUrl('usage')) },
      { title: 'Buy credits', onClick: () => buy() },
      { title: 'Close', primary: true },
    ])
  }
  let watching = null
  const buy = async () => {
    openUrl(hub.pricingUrl(SOURCE))
    if (watching) watching.aborted = true
    const signal = (watching = { aborted: false })
    render('Finish buying on layergrab.com. The new balance shows up here on its own.')
    try {
      const next = await hub.waitForPurchase(key, account, { signal: { get aborted() { return signal.aborted || panel.closed } } })
      if (next) {
        account = next
        render('Your new balance is here. Thanks!')
      } else render()
    } catch (e) {
      if (hub.isDisconnected(e)) {
        clearKey()
        connectView(panel, DISCONNECTED)
      }
    }
  }
  render()
}

function connectView(panel, note) {
  const hub = hubClient()
  panel.set(
    'Log in to LayerGrab',
    `${note ? `${note}\n` : ''}Splitting uses your LayerGrab credits. Click Log in with Google: your browser opens layergrab.com, where you choose your Google account (new accounts get free credits in supported regions) and click Approve.`,
    false,
  )
  panel.buttons([{ title: 'Cancel' }, { title: 'Log in with Google', primary: true, onClick: () => connect(panel) }])
}

async function connect(panel) {
  const hub = hubClient()
  const signal = { aborted: false }
  const cancel = () => {
    signal.aborted = true
  }
  panel.set('Starting…', '', true)
  panel.buttons([{ title: 'Cancel', onClick: cancel }])
  try {
    const grant = await hub.startConnect(CLIENT_NAME)
    const waiting = (msLeft) =>
      panel.set('Approve in your browser', `We opened layergrab.com. Sign in with Google if asked, then click Approve. Code ${grant.userCode} · expires in ${mmss(msLeft)}`, true)
    waiting(grant.expiresAt - Date.now())
    panel.buttons([
      { title: 'Open the page again', onClick: () => openUrl(grant.url) },
      { title: 'Cancel', onClick: cancel },
    ])
    openUrl(grant.url)
    const key = await hub.waitForApproval(grant, {
      signal: { get aborted() { return signal.aborted || panel.closed } },
      onTick: waiting,
    })
    saveKey(key)
    await accountView(panel)
  } catch (e) {
    if (panel.closed) return
    if (e instanceof hub.CancelledError) return connectView(panel)
    connectView(panel, hub.redact(e.message))
  }
}

export { DISCONNECTED, clearKey }

// Opened from the Account button in the LayerGrab dialog, and on its own when signed out.
export default function onAccount() {
  showAccountPanel()
}
