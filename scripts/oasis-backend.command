#!/bin/bash
#
# Oasis - macOS 後端啟動器（僅供打包版 / GitHub Release zip 使用）
#
# CI 在組裝 oasis-backend-macos-arm64.zip 時會把這支腳本複製進
# dist/oasis-backend/，和 oasis-backend 執行檔放在同一層（見 release.yml）。
# 存在的理由是雙擊體驗：
#   - Finder 對一個裸執行檔沒有預設開啟方式，雙擊不會發生任何事；.command
#     腳本則有 LaunchServices 的固定關聯，雙擊會被 Terminal.app 開啟並執行。
#   - 這支腳本本身一樣是從 zip 解壓出來、帶著 quarantine 標記的檔案，Finder
#     雙擊一樣會先被 Gatekeeper 擋下（先前版本以為腳本內部 shell 執行
#     ./oasis-backend 能繞過這道檢查，實測是錯的：擋下發生在雙擊「這支腳本」
#     本身的當下，腳本內容根本沒機會執行）。因此不再假裝能免除那一次性步驟，
#     而是接在 使用說明.txt／README 既有的「解壓縮後對整個資料夾跑一次
#     xattr -cr .」之後：那個指令本來就是遞迴清除，這支腳本跟 oasis-backend
#     會一起被清掉 quarantine 標記，之後雙擊兩者都不會再被攔。
#
# 這支腳本刻意不自己組一份「啟動成功」橫幅：那份文字的單一來源是
# backend/api.py 的 @app.on_event('startup') hook，只有它才真正知道 uvicorn
# 何時綁定完成。這裡只是把 ./oasis-backend 的 stdout/stderr 接進 Terminal
# 視窗——Windows 靠 console=True 自動開主控台看到一模一樣的文字，這支腳本
# 靠 Finder 對 .command 的固定關聯做同一件事。改動「啟動時要印什麼」只需要
# 改 api.py 一個地方，兩平台就會自動同步；這裡不該再重複那份文字。
#
# 腳本結束前一律停在 read，讓 Terminal 視窗留著，這樣使用者才看得到
# 上面印出的錯誤或最後的狀態，不會一閃就關掉。

cd "$(dirname "$0")"

echo ""
echo "======================================================"
echo "  Oasis - macOS 後端啟動器"
echo "======================================================"
echo ""

if [ ! -f "./oasis-backend" ]; then
    echo "❌ 找不到 oasis-backend 執行檔。"
    echo "   請確認你是完整解壓縮下載的 zip，而不是只複製了這支腳本。"
    echo ""
    read -p "按 Enter 鍵關閉視窗..."
    exit 1
fi
chmod +x ./oasis-backend

if [ -d "/Applications/Google Chrome.app" ]; then
    echo "✅ 已偵測到 Google Chrome"
else
    echo "⚠️  未偵測到 Google Chrome —— 下載影片時解析網頁需要它"
    echo "   請至 https://www.google.com/chrome/ 安裝後再試一次"
fi
echo ""

# Backgrounded (not exec'd) so this shell survives the backend exiting -- that's
# what keeps the Terminal window open at the final `read` below instead of
# Terminal closing it the instant the process tree ends. Job control is off in
# a non-interactive shell, so the child stays in this script's process group
# and Ctrl+C in the window still reaches it directly.
./oasis-backend &
BACKEND_PID=$!
wait "$BACKEND_PID"

echo ""
read -p "後端已結束，按 Enter 鍵關閉視窗..."
