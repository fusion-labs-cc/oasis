# OASIS Chrome Extension

A minimal Manifest V3 Chrome extension, styled after the Oasis website (dark
surfaces, emerald accent, the Oasis cat logo). Click the toolbar icon to see every
saved URL with its creation date; click **Save current tab** to add the active page.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `chrome-extension/` folder.

## Sharing data with incognito windows

The saved list lives in `chrome.storage.local`. With `"incognito": "spanning"`
(the default set in `manifest.json`), a single extension process serves both
normal and incognito windows, so the two share the exact same store — save in one,
it appears in the other.

To use the extension inside incognito at all you must grant it access:

1. Open `chrome://extensions`, find **OASIS**, click **Details**.
2. Enable **Allow in Incognito**.

Without that toggle Chrome simply won't run the extension in incognito windows.

## Files

- `manifest.json` — MV3 config, permissions (`storage`, `tabs`), spanning incognito.
- `popup.html` / `popup.css` — the list UI shown when the extension is activated.
- `popup.js` — read/write `chrome.storage.local`, render the list, save/delete.
