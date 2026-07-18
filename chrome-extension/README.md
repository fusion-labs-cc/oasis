# OASIS 瀏覽器擴充功能

一個極簡的 Manifest V3 Chrome 擴充功能，沿用 Oasis 網站的風格（深色底、翡翠綠強
調色、Oasis 貓咪標誌）。點工具列圖示即可看到所有已儲存的網址與其儲存時間；按
**儲存目前分頁** 把目前頁面加進清單。

## 安裝（未封裝）

1. 開啟 `chrome://extensions`。
2. 打開右上角的 **開發人員模式**。
3. 點 **載入未封裝項目**，選擇這個 `chrome-extension/` 資料夾。

## 與無痕視窗共用資料

清單資料存在 `chrome.storage.local`。因為 `manifest.json` 預設設了
`"incognito": "spanning"`，同一個擴充功能程序同時服務一般視窗與無痕視窗，兩者共用
完全相同的儲存空間 — 在其中一邊儲存，另一邊也會出現。

要讓擴充功能能在無痕模式下執行，必須先授權：

1. 開啟 `chrome://extensions`，找到 **OASIS**，點 **詳細資料**。
2. 開啟 **允許在無痕模式下執行**。

沒開這個開關，Chrome 就不會讓擴充功能在無痕視窗執行。

## 檔案

- `manifest.json` — MV3 設定、權限（`storage`、`tabs`）、spanning 無痕模式。
- `popup.html` / `popup.css` — 啟用擴充功能時顯示的清單介面。
- `popup.js` — 讀寫 `chrome.storage.local`、渲染清單、儲存／刪除。
