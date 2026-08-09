import { Button, Field, Input, Select } from "@fluentui/react-components";
import { Save24Regular } from "@fluentui/react-icons";
import { useMemo, useState } from "react";
import { localDateTimeValue, toIso } from "../format";
import type { Account } from "../types";
import { Section } from "./Common";

type TransactionType = "opening" | "expense" | "income" | "transfer" | "card";

export function TransactionsView({ accounts, mutate }: { accounts: Account[]; mutate: (path: string, body: unknown, success: string) => Promise<void> }) {
  const personal = useMemo(() => accounts.filter((account) => !account.is_system), [accounts]);
  const assets = personal.filter((account) => account.kind === "asset");
  const liquid = assets.filter((account) => account.is_liquid);
  const liabilities = personal.filter((account) => account.kind === "liability");
  const payments = personal.filter((account) => account.kind === "asset" || account.kind === "liability");
  const [type, setType] = useState<TransactionType>("expense");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState(localDateTimeValue());
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");

  function optionsForPrimary() {
    if (type === "income" || type === "transfer" || type === "opening") return assets;
    if (type === "card") return liquid;
    return payments;
  }

  function optionsForSecondary() {
    if (type === "transfer") return assets;
    if (type === "card") return liabilities;
    return [];
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const common = { amount, occurred_at: toIso(occurredAt), description, idempotency_key: crypto.randomUUID() };
    if (type === "opening") await mutate("/api/transactions/opening-balance", { ...common, account_id: primary }, "期初餘額已入帳");
    if (type === "expense") await mutate("/api/transactions/expense", { ...common, payment_account_id: primary }, "支出已入帳");
    if (type === "income") await mutate("/api/transactions/income", { ...common, destination_account_id: primary }, "收入已入帳");
    if (type === "transfer") await mutate("/api/transactions/transfer", { ...common, from_account_id: primary, to_account_id: secondary }, "轉帳已入帳");
    if (type === "card") await mutate("/api/transactions/card-payment", { ...common, bank_account_id: primary, card_account_id: secondary }, "卡費繳款已入帳");
    setAmount(""); setDescription("");
  }

  const primaryOptions = optionsForPrimary();
  const secondaryOptions = optionsForSecondary();
  return (
    <div className="view-stack">
      <Section title="新增交易">
        <form className="form-grid" onSubmit={submit}>
          <Field label="交易類型" required><Select value={type} onChange={(event) => { setType(event.target.value as TransactionType); setPrimary(""); setSecondary(""); }}>
            <option value="expense">支出</option><option value="income">收入</option><option value="transfer">帳戶互轉</option><option value="card">信用卡繳款</option><option value="opening">期初餘額</option>
          </Select></Field>
          <Field label="金額" required><Input type="number" min="0.000001" step="0.01" value={amount} onChange={(_, data) => setAmount(data.value)} /></Field>
          <Field label="描述" required><Input value={description} onChange={(_, data) => setDescription(data.value)} /></Field>
          <Field label="發生時間" required><Input type="datetime-local" value={occurredAt} onChange={(_, data) => setOccurredAt(data.value)} /></Field>
          <Field label={type === "transfer" ? "轉出帳戶" : type === "card" ? "繳款銀行" : "帳戶"} required>
            <Select value={primary} onChange={(event) => setPrimary(event.target.value)}><option value="">請選擇</option>{primaryOptions.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</Select>
          </Field>
          {secondaryOptions.length ? <Field label={type === "card" ? "信用卡" : "轉入帳戶"} required>
            <Select value={secondary} onChange={(event) => setSecondary(event.target.value)}><option value="">請選擇</option>{secondaryOptions.map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}</Select>
          </Field> : null}
          <div className="form-actions"><Button type="submit" appearance="primary" icon={<Save24Regular />} disabled={!amount || !description.trim() || !primary || (secondaryOptions.length > 0 && !secondary)}>正式入帳</Button></div>
        </form>
      </Section>
      <Section title="帳務規則">
        <div className="rule-grid">
          <p><strong>信用卡消費</strong><br />支出增加，負債增加，可用現金下降。</p>
          <p><strong>信用卡繳款</strong><br />銀行與負債同時下降，不會再次計入支出。</p>
          <p><strong>帳戶互轉</strong><br />只改變資產位置，不影響淨資產或支出。</p>
          <p><strong>歷史修正</strong><br />API 只提供沖銷，不直接覆寫原始 posting。</p>
        </div>
      </Section>
    </div>
  );
}
