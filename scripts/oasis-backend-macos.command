#!/bin/bash
#
# Oasis - macOS 後端啟動器（僅供打包版 / GitHub Release zip 使用）
#
# CI 在組裝 oasis-backend-macos-arm64.zip 時會把這支腳本複製進
# dist/oasis-backend/，和 oasis-backend 執行檔放在同一層（見 release.yml）。
# 存在的理由是雙擊體驗：
#   - Finder 對一個裸執行檔沒有預設開啟方式，雙擊不會發生任何事；.command
#     腳本則會被 Terminal.app 開啟並執行。
#   - macOS Gatekeeper「無法確認開發者」的封鎖，只在 Finder / Launch Services
#     直接開啟一個有 quarantine 標記的執行檔時觸發；從這支腳本內用 shell
#     執行 ./oasis-backend 則不會經過那道檢查，使用者因此不需要自己
#     右鍵「打開」或到「隱私權與安全性」設定裡放行。
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

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

echo ""
echo "🟢 後端啟動中，請稍候..."
echo "======================================================"
echo ""

# Run in the background so this script can poll for a real response instead of
# just printing a banner and hoping -- uvicorn's own startup log lines are easy
# to miss among uwsgi/DB/site-adapter output, so "did it actually work" isn't
# obvious from raw output alone. This is a plain (non-interactive) shell, so
# job control is off and the background child stays in the same process group
# as this script -- Ctrl+C in the Terminal window still reaches it directly.
./oasis-backend &
BACKEND_PID=$!

READY=0
for _ in $(seq 1 30); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
        break   # already exited -- startup failed, no point polling further
    fi
    if curl -s -o /dev/null --max-time 1 -H "X-Oasis-Client: 1" "http://$HOST:$PORT/api/health"; then
        READY=1
        break
    fi
    sleep 1
done

echo ""
if [ "$READY" = "1" ]; then
    echo "======================================================"
    echo "  ✅ 後端已成功啟動！"
    echo ""
    echo "  http://$HOST:$PORT"
    echo "  請開啟已部署的網頁前端，它會自動連線到這裡。"
    echo "  按 Ctrl+C 可停止後端。"
    echo "======================================================"
else
    echo "======================================================"
    echo "  ⚠️  30 秒內未偵測到後端成功啟動，請往上察看有無錯誤訊息。"
    echo "======================================================"
fi
echo ""

wait "$BACKEND_PID"

echo ""
read -p "後端已結束，按 Enter 鍵關閉視窗..."
