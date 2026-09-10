import type { Dashboard } from "../types";
import { Section } from "./Common";

export function ExplanationView({ dashboard }: { dashboard: Dashboard | null }) {
  return <div className="view-stack help-view">
    <h1>說明</h1>
    <Section title="資產與股票"><p>總資產包含活動資金、股票及其他資產；負債另列。暫估淨資產會保留缺價、匯率與對帳限制。</p><p>總覽顯示時約每 25 秒更新股票，報價以來源時間為準。現價以原幣顯示，市值換算為台幣；缺價或缺匯率的部位不納入占比分母。市值為零時圖表顯示透明輪廓，資料不足不當成零。</p>{dashboard ? <><p>{dashboard.review.asset_allocation.policy}</p><p>{dashboard.review.stock_allocation.policy}</p></> : null}</Section>
    <Section title="資產歷史"><p>歷史圖使用每日保存的不可變估值快照，不是即時總覽。缺少日期不補零，線段遇到缺日會中斷；縱軸依區間縮放。空心虛線點代表暫估資料。資料少於 8 點時不連線。</p></Section>
    <Section title="消費去向"><p>同一分類、店家或描述會合併，金額以正式帳本為準。先列前五項，全部消費明細可展開。</p>{dashboard ? <p>{dashboard.review.spending.ranges[dashboard.review.spending.default_range].policy}</p> : null}</Section>
    <Section title="e財庫與交割"><p>一般資金與 e財庫之間使用帳戶互轉，只改變資產位置，不算收入或支出。e財庫現金買賣股票則使用投資交易，不可再次以互轉登記同一筆交割。</p><p>e財庫 USD 現金依參考匯率換算，可能與券商 App 的台幣購買力不同。現金與帳本對應後避免重複加總；購買力與可出金不另加為資產。</p><p>交割表正數為應收，負數為應付，日期直接採券商回傳。日期與券商標記不能證明已入帳；台股表列交割金額不與美股 USD 現金直接相加，也不是可用現金。</p></Section>
    <Section title="盤點與帳務"><p>保存實際餘額先建立觀察；點選「確定」才會依觀察時間建立平衡調整交易，不列為收入或消費，之後的交易仍保留。保留現金是預留資金設定，不會修改帳戶餘額。</p><p>信用卡消費增加支出與負債；繳卡費不再次計入支出。歷史修正透過沖銷或調整，不覆寫原始紀錄。</p></Section>
    <Section title="備份"><p>備份使用 SQLite online backup 建立一致副本，附 SHA-256 manifest 與完整性檢查；還原只允許新目標。</p></Section>
  </div>;
}
