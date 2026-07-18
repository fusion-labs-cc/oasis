import type { Metadata } from "next";
import { Code, Ext, Highlight, List, PageTitle, REPO_URL, Section } from "../parts";

export const metadata: Metadata = {
  title: "隱私權 — OASIS",
  description: "OASIS 不收集任何個人資料。這頁說明為什麼，以及唯一會被儲存的東西是什麼。",
};

export default function PrivacyPage() {
  return (
    <>
      <PageTitle
        title="隱私權政策"
        lede="這是一份很短的隱私權政策，因為我們幾乎沒有東西可以寫。"
      />

      <Section n={1} title="簡短版">
        <Highlight>
          我們不收集你的任何個人資料。沒有帳號、沒有 cookie、沒有分析工具、沒有追蹤像素、沒有伺服器端資料庫。你的影片、資料與使用行為從未離開你的裝置。
        </Highlight>
      </Section>

      <Section n={2} title="你的資料在哪裡">
        <p>
          OASIS 的架構決定了這件事：本網站只是一個靜態前端，真正的後端跑在你自己的機器上，由你自己啟動。
        </p>
        <List
          items={[
            <>
              你的影片檔案（<Code>movies/</Code>）與影片目錄資料庫（<Code>oasis.db</Code>
              ）只存在於你的裝置，永遠不會上傳到任何地方。
            </>,
            <>
              前端只會與你在入口自行輸入的位址（預設 <Code>http://localhost:8000</Code>
              ）通訊。那個後端由你執行、由你掌控。
            </>,
            <>
              我們沒有任何伺服器可以接收這些資料，即使想看也看不到——因為根本沒有這條路徑。
            </>,
          ]}
        />
      </Section>

      <Section n={3} title="瀏覽器裡儲存的東西">
        <p>
          我們只使用瀏覽器的 <Code>localStorage</Code>，而且都是為了讓介面能運作。這些資料留在你的瀏覽器裡，不會傳送給我們：
        </p>
        <List
          items={[
            <>
              <Code>oasis:authorized</Code>——你是否已通過入口，避免每次重新整理都要再連一次。
            </>,
            <>你的後端位址（入口座標），讓下次能自動連線。</>,
            <>你的個人設定：鍵盤快速鍵、Awake 模式的開關與狀態。</>,
          ]}
        />
        <p>
          清除瀏覽器資料即可將這些全部移除。我們{" "}
          <strong className="font-semibold text-text-primary">不使用 cookie</strong>
          ，因此本站也沒有 cookie 同意橫幅。
        </p>
      </Section>

      <Section n={4} title="本網站的託管與第三方請求">
        <p>
          本站的靜態檔案託管於 Cloudflare。作為 CDN，Cloudflare 會在其邊緣節點產生標準的存取紀錄（IP 位址、時間、User-Agent），用於傳輸與濫用防護；這是任何網站託管都無法避免的一環，我們不保存、不分析，也不會將其與任何個人建立關聯。詳見{" "}
          <Ext href="https://www.cloudflare.com/privacypolicy/">Cloudflare 的隱私政策</Ext>。
        </p>
        <p>
          字型檔在建置時就已內嵌自架，因此瀏覽本站{" "}
          <strong className="font-semibold text-text-primary">不會向 Google Fonts 或任何第三方發出請求</strong>
          。此外，這幾頁法律頁面刻意不載入應用程式本體，所以你正在看的這一頁完全不會嘗試連線任何後端。
        </p>
      </Section>

      <Section n={5} title="離開本站之後">
        <p>
          入口頁的下載連結會將你導向第三方（例如 GitHub Releases 或雲端硬碟）。一旦離站，你就受該服務的隱私政策規範，我們無從得知也無法控制。
        </p>
        <p>
          同樣地，若你使用打包版並在設定頁按下「檢查更新」，是{" "}
          <strong className="font-semibold text-text-primary">你的後端直接向 GitHub 發出請求</strong>
          ，GitHub 因此會看到你的 IP。這個請求不經過我們的任何伺服器。
        </p>
      </Section>

      <Section n={6} title="你的權利">
        <p>
          因為我們不持有你的任何個人資料，也就沒有可供查詢、更正或刪除的對象。你想「刪除全部資料」的話，刪掉自己機器上的檔案與瀏覽器儲存即可，不需要通知我們，也不需要我們同意。
        </p>
      </Section>

      <Section n={7} title="政策變更">
        <p>
          若本政策有所變更，會直接更新於本頁並標示日期，歷次變更可在{" "}
          <Ext href={REPO_URL}>GitHub 儲存庫</Ext>的版本紀錄中查閱。
        </p>
      </Section>
    </>
  );
}
