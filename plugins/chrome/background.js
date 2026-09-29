// Opens the side panel from the toolbar button, and adds "Split this image
// into layers" to the right-click menu on images. The picked image is handed
// to the panel through chrome.storage.session, which the panel watches.

const MENU_ID = 'layergrab-split-image'

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  chrome.contextMenus.create({ id: MENU_ID, title: 'Split this image into layers', contexts: ['image'] })
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return
  // open() must run inside the click handler, before any await, to count as a user gesture.
  if (tab && tab.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {})
  chrome.storage.session.set({ pickedImage: { srcUrl: info.srcUrl, pageUrl: info.pageUrl || '', at: Date.now() } })
})
