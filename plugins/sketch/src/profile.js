import Settings from 'sketch/settings'

// The signed-in account's Google picture and name, kept on this Mac so the
// LayerGrab dialog can show them straight away (it is modal and cannot wait
// for the network). Refreshed whenever the account is loaded; removed on
// sign-out.

const URL_KEY = 'layergrab-avatar-url'
const NAME_KEY = 'layergrab-profile-name'

function cacheFile() {
  const dir = NSString.stringWithString('~/Library/Caches/com.layergrab.sketch').stringByExpandingTildeInPath()
  NSFileManager.defaultManager().createDirectoryAtPath_withIntermediateDirectories_attributes_error(dir, true, null, null)
  return `${dir}/avatar`
}

/** Save the account's name and picture. Never throws. */
export async function rememberAccount(account) {
  try {
    Settings.setSettingForKey(NAME_KEY, account.email ? `${account.name} · ${account.email}` : account.name)
    const url = account.avatarUrl || ''
    const file = cacheFile()
    const have = NSFileManager.defaultManager().fileExistsAtPath(file)
    if (!url) {
      if (have) NSFileManager.defaultManager().removeItemAtPath_error(file, null)
      Settings.setSettingForKey(URL_KEY, '')
      return
    }
    if (have && Settings.settingForKey(URL_KEY) === url) return
    const res = await fetch(url)
    if (!res.ok) return
    const data = await res.blob() // NSData in Sketch
    if (data.writeToFile_atomically(file, true)) Settings.setSettingForKey(URL_KEY, url)
  } catch (e) {
    // the dialog falls back to a generic icon
  }
}

/** Forget the name and picture (sign-out, or signed out from the website). */
export function forgetAccount() {
  try {
    Settings.setSettingForKey(NAME_KEY, '')
    Settings.setSettingForKey(URL_KEY, '')
    const file = cacheFile()
    if (NSFileManager.defaultManager().fileExistsAtPath(file)) NSFileManager.defaultManager().removeItemAtPath_error(file, null)
  } catch (e) {
    // nothing to clean up
  }
}

/** "Name · email" of the last loaded account, or ''. */
export function rememberedName() {
  try {
    const v = Settings.settingForKey(NAME_KEY)
    return typeof v === 'string' ? v : ''
  } catch (e) {
    return ''
  }
}

/** The saved picture as a round NSImage of `size` points, or null. */
export function avatarImage(size) {
  try {
    const file = cacheFile()
    if (!NSFileManager.defaultManager().fileExistsAtPath(file)) return null
    const src = NSImage.alloc().initWithContentsOfFile(file)
    if (!src || !src.isValid()) return null
    const out = NSImage.alloc().initWithSize(NSMakeSize(size, size))
    out.lockFocus()
    NSBezierPath.bezierPathWithOvalInRect(NSMakeRect(0, 0, size, size)).addClip()
    src.drawInRect_fromRect_operation_fraction(NSMakeRect(0, 0, size, size), NSMakeRect(0, 0, 0, 0), 2, 1) // NSCompositingOperationSourceOver
    out.unlockFocus()
    return out
  } catch (e) {
    return null
  }
}
