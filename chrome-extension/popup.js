// chrome.storage.local is the single shared store. With "incognito": "spanning"
// (the default), one extension process serves both normal and incognito windows,
// so anything written here is visible from either — that is what makes the saved
// list identical across a normal tab and an incognito tab.
const STORAGE_KEY = "savedUrls";
const HIDDEN_KEY = "hiddenMode";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const hideBtn = document.getElementById("hide");
const listView = document.getElementById("listView");

// Open eye = list visible (click to hide); closed eye = list hidden.
const EYE_OPEN =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

async function getSaved() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function setSaved(items) {
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

async function isHidden() {
  const data = await chrome.storage.local.get(HIDDEN_KEY);
  return data[HIDDEN_KEY] === true;
}

async function setHidden(value) {
  await chrome.storage.local.set({ [HIDDEN_KEY]: value });
}

function flash(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => {
    statusEl.hidden = true;
  }, 2000);
}

function formatDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

async function render() {
  const hidden = await isHidden();

  // In hidden mode the list is withheld entirely; the eye icon toggles it back.
  // Save stays available so the current tab can still be captured while hidden.
  listView.hidden = hidden;
  hideBtn.innerHTML = hidden ? EYE_CLOSED : EYE_OPEN;
  hideBtn.title = hideBtn.ariaLabel = hidden ? "顯示清單" : "隱藏清單";
  if (hidden) return;

  const items = await getSaved();
  listEl.textContent = "";
  emptyEl.hidden = items.length > 0;

  // Newest first.
  items
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .forEach((item) => {
      const li = document.createElement("li");
      li.className = "item";

      const main = document.createElement("div");
      main.className = "item-main";

      const a = document.createElement("a");
      a.href = item.url;
      a.textContent = item.title || item.url;
      a.title = item.title || item.url; // hover shows the full title
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openIncognito(item.url);
      });

      const time = document.createElement("time");
      time.dateTime = item.createdAt;
      time.textContent = formatDate(item.createdAt);

      main.append(a, time);

      const remove = document.createElement("button");
      remove.className = "remove";
      remove.type = "button";
      remove.textContent = "刪除";
      remove.addEventListener("click", () => removeItem(item.id));

      li.append(main, remove);
      listEl.append(li);
    });
}

// Saved links always open in incognito. A plain <a> can't target incognito, so
// intercept the click and drive chrome.windows. Reuse an open incognito window
// (add a tab) when there is one; otherwise spawn a fresh incognito window.
async function openIncognito(url) {
  try {
    const wins = await chrome.windows.getAll();
    const incog = wins.find((w) => w.incognito);
    if (incog) {
      await chrome.tabs.create({ windowId: incog.id, url });
      await chrome.windows.update(incog.id, { focused: true });
    } else {
      await chrome.windows.create({ url, incognito: true });
    }
  } catch {
    // Fails when the user hasn't granted incognito access to the extension.
    flash("請在擴充功能設定開啟「允許在無痕模式下執行」。");
  }
}

async function removeItem(id) {
  const items = await getSaved();
  await setSaved(items.filter((item) => item.id !== id));
  render();
}

async function saveCurrent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || /^(chrome|edge|about|chrome-extension):/.test(tab.url)) {
    flash("這個頁面無法儲存。");
    return;
  }

  const items = await getSaved();
  if (items.some((item) => item.url === tab.url)) {
    flash("已經儲存過了。");
    return;
  }

  items.push({
    id: crypto.randomUUID(),
    url: tab.url,
    title: tab.title || "",
    createdAt: new Date().toISOString(),
  });
  await setSaved(items);
  flash("已儲存。");
  render();
}

saveBtn.addEventListener("click", saveCurrent);

hideBtn.addEventListener("click", async () => {
  await setHidden(!(await isHidden()));
  render();
});

// Keep the view live if another window (e.g. incognito) changes the store.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[STORAGE_KEY] || changes[HIDDEN_KEY])) render();
});

render();
