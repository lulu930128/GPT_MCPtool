import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@fluentui/react-components";
import { Add24Regular } from "@fluentui/react-icons";
import { useState } from "react";
import type { Account } from "../types";
import { formatCurrency } from "../format";
import { EmptyState, Section } from "./Common";

const subtypeByKind: Record<string, string[]> = {
  asset: ["cash", "bank", "broker_cash", "investment", "other"],
  liability: ["credit_card", "other"],
};

const subtypeLabels: Record<string, string> = {
  cash: "現金",
  bank: "銀行",
  broker_cash: "券商交割帳戶",
  investment: "投資資產",
  credit_card: "信用卡",
  other: "其他",
};

export function AccountsView({
  accounts,
  mutate,
}: {
  accounts: Account[];
  mutate: (path: string, body: unknown, success: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("asset");
  const [subtype, setSubtype] = useState("bank");
  const [institution, setInstitution] = useState("");
  const [liquid, setLiquid] = useState(true);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutate("/api/accounts", { name, kind, subtype, institution: institution || null, currency: "TWD", is_liquid: liquid }, "帳戶已建立");
    setName("");
    setInstitution("");
  }

  const personal = accounts.filter((account) => !account.is_system);
  return (
    <div className="view-stack">
      <Section title="新增帳戶">
        <form className="form-grid" onSubmit={submit}>
          <Field label="帳戶名稱" required><Input value={name} onChange={(_, data) => setName(data.value)} /></Field>
          <Field label="主要類型" required>
            <Select value={kind} onChange={(event) => {
              const next = event.target.value;
              setKind(next); setSubtype(subtypeByKind[next]?.[0] ?? "other"); setLiquid(next === "asset");
            }}>
              <option value="asset">資產</option><option value="liability">負債</option>
            </Select>
          </Field>
          <Field label="子類型" required>
            <Select value={subtype} onChange={(event) => setSubtype(event.target.value)}>
              {(subtypeByKind[kind] ?? ["other"]).map((value) => <option key={value} value={value}>{subtypeLabels[value] ?? value}</option>)}
            </Select>
          </Field>
          <Field label="機構"><Input value={institution} onChange={(_, data) => setInstitution(data.value)} /></Field>
          <Checkbox checked={liquid} disabled={kind !== "asset"} onChange={(_, data) => setLiquid(Boolean(data.checked))} label="計入流動現金" />
          <div className="form-actions"><Button type="submit" appearance="primary" icon={<Add24Regular />} disabled={!name.trim()}>建立帳戶</Button></div>
        </form>
      </Section>

      <Section title="我的帳戶">
        {personal.length === 0 ? <EmptyState title="尚無個人帳戶" body="建議先建立常用銀行、信用卡與投資帳戶。" /> : (
          <div className="table-scroll"><Table aria-label="我的帳戶">
            <TableHeader><TableRow><TableHeaderCell>帳戶</TableHeaderCell><TableHeaderCell>類型</TableHeaderCell><TableHeaderCell>機構</TableHeaderCell><TableHeaderCell>帳面餘額</TableHeaderCell></TableRow></TableHeader>
            <TableBody>{personal.map((account) => <TableRow key={account.id}>
              <TableCell><strong>{account.name}</strong></TableCell><TableCell>{subtypeLabels[account.subtype] ?? account.subtype}</TableCell>
              <TableCell>{account.institution ?? "未設定"}</TableCell><TableCell className="number-cell">{formatCurrency(account.display_balance)}</TableCell>
            </TableRow>)}</TableBody>
          </Table></div>
        )}
      </Section>
    </div>
  );
}
