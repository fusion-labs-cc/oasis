import type { Metadata } from "next";
import Link from "next/link";
import { Code, Ext, Highlight, List, PageTitle, REPO_URL, Section } from "../parts";

export const metadata: Metadata = {
  title: "使用條款 — OASIS",
  description: "OASIS 的使用條款與免責聲明。",
};

export default function TermsPage() {
  return (
    <>
      <PageTitle
        title="使用條款與免責聲明"
        lede="以下條款規範你取得、安裝與使用 OASIS 軟體，以及使用本網站。開始使用即表示你同意這些條款；若不同意，請勿使用。"
      />

      <Section n={1} title="OASIS 是什麼">
        <p>
          OASIS 是一套在你自己的裝置上執行的個人影音管理與下載工具。它是一個
          <strong className="font-semibold text-text-primary">通用的網頁讀取與下載引擎</strong>
          ，本身不內建任何特定網站的定義。
        </p>
        <Highlight>
          本專案不提供、不代管、不索引，也不散布任何影音內容。要讓引擎對某個網站生效，必須由你自行撰寫並提供該站的 adapter 設定檔（
          <Code>backend/sites/</Code>）。這份設定與其後果，屬於你的行為與責任。
        </Highlight>
      </Section>

      <Section n={2} title="沒有服務，也沒有帳號">
        <p>
          本網站只是一個靜態前端。所有的解析、下載、轉檔、資料庫與播放，都在你自己的裝置與你自己啟動的後端上執行。我們不營運任何內容伺服器、不提供任何線上服務、沒有帳號系統，也無法看見你在自己機器上做了什麼。
        </p>
        <p>
          因此，本網站沒有可供中止或退款的「服務」，也不對你的後端能否運作、能否連上任何網站作出任何承諾。
        </p>
      </Section>

      <Section n={3} title="你的責任">
        <p>使用本軟體時，你聲明並保證：</p>
        <List
          items={[
            <>
              你自行提供的每一份 adapter，其存取行為都符合目標網站的
              <strong className="font-semibold text-text-primary">服務條款</strong>
              、robots 政策，以及你所在地的法律。
            </>,
            <>
              你只對自己
              <strong className="font-semibold text-text-primary">有合法權利存取</strong>
              的內容使用本軟體，並自行確認該內容的重製與保存在你的管轄地屬於合法行為（例如個人備份的合理使用範圍）。
            </>,
            <>
              若目標內容受年齡限制，你已達所在地的法定年齡，且該內容在你所在地並不違法。
            </>,
            <>
              下載後的檔案存放在你的裝置上，其保存、使用與後續散布（我們強烈建議：不要散布）完全由你負責。
            </>,
          ]}
        />
      </Section>

      <Section n={4} title="禁止的使用方式">
        <p>不得將本軟體用於：</p>
        <List
          items={[
            <>規避著作權技術保護措施（若此行為在你所在地違法）。</>,
            <>高頻率、大規模的抓取，導致目標網站服務品質下降或中斷。</>,
            <>重製、公開傳輸或散布你不擁有權利的內容。</>,
            <>任何違反你所在地法律的行為。</>,
          ]}
        />
      </Section>

      <Section n={5} title="軟體授權">
        <p>
          OASIS 的原始碼依{" "}
          <Ext href="https://www.apache.org/licenses/LICENSE-2.0">Apache License 2.0</Ext>{" "}
          授權，你可以自由使用、修改與再散布，但須遵守該授權條款。打包版另含第三方元件（其中 FFmpeg 為 GPL-3.0），其授權與義務詳見{" "}
          <Link
            href="/licenses"
            className="text-text-primary underline decoration-border-hairline underline-offset-4 transition hover:text-accent hover:decoration-accent/50"
          >
            授權與致謝
          </Link>
          。
        </p>
      </Section>

      <Section n={6} title="無擔保與責任限制">
        <p>
          本軟體以「
          <strong className="font-semibold text-text-primary">現狀」（AS IS）</strong>
          提供，不附任何明示或默示的擔保，包括但不限於可商用性、特定用途適用性與不侵權之擔保。
        </p>
        <p>
          在法律允許的最大範圍內，作者與貢獻者不對任何直接、間接、附帶、衍生或懲罰性的損害負責，包括資料遺失、檔案毀損、下載中斷，或你因使用本軟體而承擔的任何法律責任。此限制與 Apache License 2.0 第 7、8 條一致。
        </p>
      </Section>

      <Section n={7} title="與第三方網站無關">
        <p>
          本專案與任何影音網站、平台或內容供應者均無關聯、未經其背書，也不代表其立場。所有商標歸各自所有人所有。
        </p>
      </Section>

      <Section n={8} title="條款變更">
        <p>
          我們可能隨時更新本條款；更新後的版本一經發佈於本頁即生效，頁首會標示最後更新日期。條款的歷次變更可在{" "}
          <Ext href={REPO_URL}>GitHub 儲存庫</Ext>的版本紀錄中查閱。若你不同意更新後的條款，請停止使用本軟體。
        </p>
      </Section>
    </>
  );
}
