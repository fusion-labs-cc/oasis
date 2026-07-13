import type { Metadata } from "next";
import { Code, Ext, Highlight, List, PageTitle, REPO_URL, Section } from "../parts";

export const metadata: Metadata = {
  title: "授權與致謝 — OASIS",
  description: "OASIS 的授權條款，以及它所倚賴的第三方元件與其授權。",
};

// Runtime dependencies, by layer. Keep in step with backend/requirements.txt and
// web/package.json when either changes.
const DEPS: { group: string; items: { name: string; license: string; href: string }[] }[] = [
  {
    group: "前端",
    items: [
      { name: "Next.js", license: "MIT", href: "https://github.com/vercel/next.js" },
      { name: "React / React DOM", license: "MIT", href: "https://github.com/facebook/react" },
      { name: "Tailwind CSS", license: "MIT", href: "https://github.com/tailwindlabs/tailwindcss" },
      { name: "Plyr", license: "MIT", href: "https://github.com/sampotts/plyr" },
      {
        name: "@opennextjs/cloudflare",
        license: "MIT",
        href: "https://github.com/opennextjs/opennextjs-cloudflare",
      },
      {
        name: "Geist / Geist Mono",
        license: "SIL OFL 1.1",
        href: "https://github.com/vercel/geist-font",
      },
    ],
  },
  {
    group: "後端",
    items: [
      { name: "FastAPI", license: "MIT", href: "https://github.com/fastapi/fastapi" },
      { name: "Uvicorn", license: "BSD-3-Clause", href: "https://github.com/encode/uvicorn" },
      { name: "Selenium", license: "Apache-2.0", href: "https://github.com/SeleniumHQ/selenium" },
      { name: "Requests", license: "Apache-2.0", href: "https://github.com/psf/requests" },
      {
        name: "BeautifulSoup4 / soupsieve",
        license: "MIT",
        href: "https://www.crummy.com/software/BeautifulSoup/",
      },
      { name: "m3u8", license: "MIT", href: "https://github.com/globocom/m3u8" },
      {
        name: "PyCryptodome",
        license: "BSD-2-Clause / Public Domain",
        href: "https://github.com/Legrandin/pycryptodome",
      },
      {
        name: "deep-translator",
        license: "Apache-2.0",
        href: "https://github.com/nidhaloff/deep-translator",
      },
      { name: "urllib3", license: "MIT", href: "https://github.com/urllib3/urllib3" },
      { name: "certifi", license: "MPL-2.0", href: "https://github.com/certifi/python-certifi" },
    ],
  },
];

function DepRow({ name, license, href }: { name: string; license: string; href: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-hairline py-2 last:border-0">
      <Ext href={href}>{name}</Ext>
      <span className="shrink-0 font-mono text-[11px] text-text-tertiary">{license}</span>
    </div>
  );
}

export default function LicensesPage() {
  return (
    <>
      <PageTitle
        title="授權與致謝"
        lede="OASIS 站在許多開源專案的肩膀上。這一頁記錄它們的授權，以及打包版所隨附的第三方二進位檔必須履行的義務。"
      />

      <Section n={1} title="OASIS 本體">
        <p>
          本專案的原始碼依{" "}
          <Ext href="https://www.apache.org/licenses/LICENSE-2.0">Apache License 2.0</Ext>{" "}
          授權。完整授權全文見{" "}
          <Ext href={`${REPO_URL}/blob/main/LICENSE`}>儲存庫中的 LICENSE</Ext>。
        </p>
      </Section>

      <Section n={2} title="打包版隨附的二進位檔">
        <p>
          從發行頁下載的 Windows 打包版（<Code>oasis-portal-win64.zip</Code>
          ）內含兩個並非由本專案撰寫的第三方執行檔，兩者皆未經修改地重新散布：
        </p>

        <div className="rounded-xl border border-border-hairline bg-surface-elevated/40 p-5">
          <h3 className="mb-1 text-sm font-bold text-text-primary">
            FFmpeg <span className="ml-1 font-mono text-[11px] text-accent">GPL-3.0</span>
          </h3>
          <p className="mb-3 text-[13px] leading-relaxed text-text-secondary">
            用於合併 HLS / TS 分段並轉檔為 MP4。採用{" "}
            <Ext href="https://www.gyan.dev/ffmpeg/builds/">gyan.dev</Ext> 的 Windows 靜態建置
            （release-essentials）。該建置含有 GPL 授權的元件（如 libx264 / libx265），因此整個二進位檔受 GPL 而非 LGPL 規範。
          </p>
          <Highlight>
            <strong className="font-semibold">書面提供（Written offer）</strong>
            ：對應的原始碼可公開取得。執行 <Code>bin/ffmpeg.exe -version</Code>{" "}
            會印出版本與完整的 <Code>configuration:</Code> 建置參數；依此版本至{" "}
            <Ext href="https://git.ffmpeg.org/ffmpeg.git">git.ffmpeg.org</Ext> 或{" "}
            <Ext href="https://ffmpeg.org">ffmpeg.org</Ext> 取得對應的標籤原始碼即可。
          </Highlight>
          <p className="mt-3 text-[13px] leading-relaxed text-text-secondary">
            GPL v3 全文隨二進位檔一併附於 <Code>bin/ffmpeg-LICENSE.txt</Code>，亦可見於{" "}
            <Ext href="https://www.gnu.org/licenses/gpl-3.0.txt">gnu.org</Ext>。
          </p>
        </div>

        <div className="rounded-xl border border-border-hairline bg-surface-elevated/40 p-5">
          <h3 className="mb-1 text-sm font-bold text-text-primary">
            CPython（embeddable 發行版）
            <span className="ml-1 font-mono text-[11px] text-accent">PSF License</span>
          </h3>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            讓後端與下載器不需系統 Python 也能執行。取自{" "}
            <Ext href="https://www.python.org/downloads/windows/">python.org</Ext>{" "}
            的官方 Windows embeddable package（amd64），未經修改；PSF 授權全文隨附於{" "}
            <Code>python/LICENSE.txt</Code>。
          </p>
        </div>

        <p className="text-[13px] text-text-tertiary">
          Google Chrome 由使用者自行安裝，並非由本專案散布。
        </p>
      </Section>

      <Section n={3} title="執行時倚賴的開源套件">
        <p>以下套件在安裝時取自各自的官方來源，本專案不重新散布其程式碼：</p>
        {DEPS.map((g) => (
          <div key={g.group} className="pt-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
              {g.group}
            </span>
            <div className="mt-1">
              {g.items.map((d) => (
                <DepRow key={d.name} {...d} />
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section n={4} title="有遺漏或錯誤？">
        <p>
          我們盡力讓這份清單保持正確。若你發現任何歸屬錯誤或遺漏的元件，請到{" "}
          <Ext href={`${REPO_URL}/issues`}>GitHub Issues</Ext> 告訴我們，我們會盡快更正。
        </p>
        <List
          items={[
            <>
              最新的完整記錄（含各版本細節）見{" "}
              <Ext href={`${REPO_URL}/blob/main/THIRD-PARTY-LICENSES.txt`}>
                THIRD-PARTY-LICENSES.txt
              </Ext>
              ，它也隨每一份打包版一起散布。
            </>,
          ]}
        />
      </Section>
    </>
  );
}
