# 🎬 Oasis (綠洲) - 個人謎片管理中心

<p align="center">
  <a href="https://github.com/fusion-labs-cc/oasis/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/fusion-labs-cc/oasis?style=flat-square&label=release&color=ff5263" /></a>
  <a href="https://github.com/fusion-labs-cc/oasis/releases"><img alt="Total downloads" src="https://img.shields.io/github/downloads/fusion-labs-cc/oasis/total?style=flat-square&label=downloads&color=2ea44f" /></a>
  <a href="./LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/github/license/fusion-labs-cc/oasis?style=flat-square" /></a>
</p>

Oasis 是一個**你自己架、自己用**的個人謎片收藏中心與下載器：網頁介面是公開部署的 [oasis.fusion-labs.cc](https://oasis.fusion-labs.cc)，但實際的爬蟲、下載與資料庫都跑在**你自己的電腦上**——你的謎片清單、下載紀錄都留在你自己的硬碟裡，不會經過任何人的伺服器。

支援從多個謎片網站解析與下載（並持續擴充支援的網站），結合 Python 爬蟲後端與 Next.js 網頁前端，提供網址解析、自動翻譯、下載、手動新增、標籤與演員分類管理，到串流或本機播放器播放的一站式體驗。

> **English**: Oasis is a self-hosted personal adult video (AV) collection manager & downloader. The web UI ([oasis.fusion-labs.cc](https://oasis.fusion-labs.cc)) is publicly hosted, but scraping, downloading, and your database all run on your own machine — nothing leaves your disk. Supports auto-parsing, translation, and one-click downloading from Jable, MissAV, and SupJav.

> ⚠️ **內容性質**：本工具內建的站台 adapter 針對的是**成人謎片網站**（見下方〈支援的網站〉）。請確認你已達所在地區法定成年年齡，且下載、觀看該類內容合法，再使用本工具。

![Oasis 個人謎片管理中心 - 影片儀表板截圖 (Oasis dashboard screenshot)](./example-images/dashboard.png)
![如何用網址新增並下載影片 (How to add a video by URL)](./example-images/add-video.gif)

---

## 🧭 先選你的使用方式

不確定要選哪個？**先選第一種**——不用裝任何開發工具，最快能看到成果。

| 情境 | 建議 | 需要安裝 |
|---|---|---|
| 只想連 [oasis.fusion-labs.cc](https://oasis.fusion-labs.cc)，下載動作在自己電腦上跑（Windows / macOS 皆可） | 下載打包好的 `oasis-backend` | 不需要 git / Node.js / Python |
| 想要完整體驗、之後也想自己改程式碼 | `git clone` + 一鍵啟動腳本 | Python、Node.js（腳本會引導安裝） |

---

## 🚀 開始使用

### 方式一：只要後端，前端用公開網站

不需要 git、Node.js 或 Python：到 [Releases](../../releases) 下載對應作業系統的 `oasis-backend-*.zip`，解壓縮後：

- **Windows**：雙擊 `oasis-backend.exe`。
- **macOS**：`oasis-backend` 沒有簽章，**第一次**執行前需要手動解除隔離標記，否則雙擊會被 Gatekeeper 擋下（顯示「無法確認開發者」）：
  1. 在解壓縮後的資料夾按右鍵 →「服務」→「於資料夾建立終端機頁籤」，開啟終端機。
     （沒有這個選項的話：把整個資料夾拖到 Dock 上的「終端機」圖示，一樣能在該路徑開啟終端機。）
  2. 貼上 `xattr -cr .`，按 Enter。這行**只需要跑一次**，之後就不會再被擋。
  3. 雙擊 `oasis-backend.command` 啟動後端。
     （`oasis-backend` 本體也能雙擊直接開，差別只是少了啟動前的 Chrome 偵測提示。）

後端啟動後，直接開啟 **[oasis.fusion-labs.cc](https://oasis.fusion-labs.cc)** 即可，它會自動連到你電腦上 `http://localhost:8000` 的後端。你的影片、資料庫都存在解壓縮出來的這個資料夾裡。

### 方式二：完整原始碼（前端＋後端一起跑在你的電腦）

**macOS & Linux**：

```bash
chmod +x oasis-portal.sh
./oasis-portal.sh
```

**Windows**：建議直接雙擊執行 `oasis-portal.bat` —— 它會自動以 PowerShell 啟動整個流程，無需額外設定。

> 💡 直接雙擊 `.ps1` 檔預設只會用記事本開啟（除非你已將 `.ps1` 的預設程式設為 PowerShell）。若偏好手動在 PowerShell 中執行：`./oasis-portal.ps1`

啟動腳本會自動完成：

1. 檢測並引導安裝 Python、Node.js、FFmpeg、Google Chrome 等系統組件。
2. 在 `oasis/` 目錄建立 Python 虛擬環境並安裝 backend 依賴。
3. 自動安裝 frontend npm 依賴套件。
4. 初始化資料庫並建立 `movies/` 儲存資料夾。
5. 啟動並預載 FastAPI 後端服務（Port 8000）。
6. 啟動 Next.js 開發伺服器（Port 3000）並自動開啟瀏覽器。

只想跑後端（例如你想自己架設給區網其他裝置連）可加參數：`./oasis-portal.sh --backend-only`。

> 想改程式碼、新增站台 adapter，或想了解架構怎麼運作？看 [DEVELOPMENT.md](./DEVELOPMENT.md)。

---

## ✨ 核心特色 (Key Features)

- 🎨 **現代化網頁介面**：基於 Next.js 與 Tailwind CSS 打造的暗黑風格儀表板，支援響應式佈局。
- 🔍 **智慧元數據爬取**：輸入影片網址後，後端透過 Selenium Headless Chrome 自動提取番號、演員、標籤與封面，並自動將日文標題翻譯為繁體中文。
- 📂 **在地化資料庫管理**：所有解析或下載的影片皆儲存於本機 SQLite 資料庫 (`oasis.db`)，方便隨時檢索。
- ⚡ **序列化下載佇列與即時進度**：獨立 OS 進程下載，不阻塞 Web 伺服器；佇列逐一執行並即時顯示進度；自動處理 m3u8 播放清單、TS 分段下載、合成 MP4 與轉檔。
- 🔁 **重啟續存**：下載佇列與進度會持久化，即使後端服務重啟也能還原未完成的工作，不必從頭來過。
- 🎬 **靈活的播放方案**：內建 Plyr 播放器線上串流，或一鍵呼叫電腦預設播放器（VLC、IINA、PotPlayer 等）並自動記錄播放次數與進度。
- 🎲 **隨機挑片**：一鍵從已下載的影片中隨機跳轉到一部。
- ☑️ **多選批次操作**：在卡片上多選，一次批次匯出或刪除多部影片。
- 🔄 **JSON 匯入 / 匯出**：整份收藏庫或所選影片可匯出與匯入，方便備份與遷移。
- ✍️ **手動新增**：沒有 adapter 的網站也能收藏——自己填標題、番號、演員、標籤即可，不需要自動解析。
- 🕶️ **Awake Mode（老闆鍵偽裝）**：`⌘+X`（macOS）/ `Alt+X`（Windows 等）一鍵將整個網站偽裝成 Google 首頁，狀態跨重新整理與分頁重開持久化保留。
- 🛠️ **一鍵啟動與環境建置**：跨平台整合啟動腳本，自動安裝依賴、建立虛擬環境並同時啟動前後端。

---

## 📦 系統需求 (System Requirements)

若走「方式一：只要後端」，打包好的 `.exe` / `.command` 已內含所有需要的東西，不需要另外安裝。

若走「方式二：完整原始碼」，請確保系統已安裝：

- **Python 3.10+**（用於運行 FastAPI 後端與爬蟲下載器）
- **Node.js 18+** & **npm**（用於運行 Next.js 前端）
- **FFmpeg**（用於影音片段合併與轉檔）
- **Google Chrome** / **Chromium**（Selenium 解析網頁所需）

> 💡 **自動安裝支援**：啟動腳本（macOS/Linux: `oasis-portal.sh`，Windows: `oasis-portal.ps1`）在偵測到缺失 `FFmpeg` 或 `Chrome` 時，會嘗試透過系統套件管理器（如 `apt-get`、`brew`、`winget`）進行自動安裝。

---

## 🔄 軟體更新 (Updating)

- **原始碼版**：每次啟動 `oasis-portal` 腳本都會自動拉取最新程式碼，不用手動操作。
- **打包版**：到 **設定頁 → 關於與更新** 按「檢查更新」，有新版本的話按 **「立即更新」** 即可，後端會自己下載、更新並重新啟動。你的資料庫（`oasis.db`）與影片（`movies/`）不會受影響，會完整保留。更新期間請避免有下載工作正在進行中。

> 更新機制的實作細節（helper 程序如何抽換檔案、light/full 更新差異）在 [DEVELOPMENT.md](./DEVELOPMENT.md#軟體更新機制) 裡。

![軟體更新畫面 (Checking for and applying updates)](./example-images/updating.png)
---

## 🌐 支援的網站 (Supported Sites)

| 網站 | 網域 | 自動解析／下載 |
|---|---|---|
| [Jable](https://jable.tv) | `jable.tv` | ✅ |
| [MissAV](https://missav.ws) | `missav.*` | ✅ |
| [SupJav](https://supjav.com) | `supjav.*` | ✅ |

這三個是隨版本內建的 adapter（`backend/sites/*.json`），可以直接貼網址自動解析番號、演員、標籤、封面並下載。

**其他網站也能收藏，只是不會自動解析／下載。** 在網頁介面按「新增影片」→「手動新增」，自己填標題、番號、演員、標籤與封面圖，就能把任何網址記錄進收藏庫；要幫該網站做到跟上面三個一樣的自動解析／下載，需要自己寫一份 adapter，做法看 [DEVELOPMENT.md](./DEVELOPMENT.md#站台-adapter-設定-site-adapters)。

---

## 🙋 遇到問題 (Troubleshooting)

開 [GitHub Issue](https://github.com/fusion-labs-cc/oasis/issues/new) 之前，請先確認自己是用最新版本；回報時請附上：

- 你用的方式（打包後端 / 原始碼）、作業系統、版本號（設定頁「關於與更新」可查）。
- 觸發問題的操作步驟，以及預期結果 vs. 實際結果。
- 若後端主控台視窗有印出錯誤訊息，直接複製貼上。

⚠️ **請不要**附上你的存取碼、`oasis.db`、`oasis.auth.json` 或其他包含個資／連結的檔案內容。

---

## ⚠️ 免責聲明 (Disclaimer)

本工具內建的站台 adapter（Jable、MissAV、SupJav）皆為**成人影片（A 片）網站**，僅供已達所在地區法定成年年齡、且該地區法律允許之使用者使用。除此之外，本工具是通用的個人影音管理引擎，不內建其他任何特定網站的定義；使用者自行新增的站台 adapter 由使用者自己提供與維護。

使用者須自負其設定與使用行為，並遵守目標網站的服務條款與當地法律。

本專案依 [LICENSE](./LICENSE) 授權；第三方元件授權見 [THIRD-PARTY-LICENSES.txt](./THIRD-PARTY-LICENSES.txt)。
