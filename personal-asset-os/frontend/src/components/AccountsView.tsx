import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} from "@fluentui/react-components";
import { Add24Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { activityFundCandidates } from "../activity-fund";
import { formatCurrency } from "../format";
import type { Account } from "../types";
import { Section } from "./Common";

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
  const [name, setName] = useState("活動資金");
  const [subtype, setSubtype] = useState("bank");
  const [institution, setInstitution] = useState("");
  const candidates = activityFundCandidates(accounts);
  const activityFund = candidates.length === 1 ? candidates[0] : null;
  const otherPersonal = accounts.filter(
    (account) => !account.is_system && !candidates.some((candidate) => candidate.id === account.id),
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await mutate(
      "/api/accounts",
      {
        name,
        kind: "asset",
        subtype,
        institution: institution || null,
        currency: "TWD",
        is_liquid: true,
      },
      "活動資金帳戶已建立",
    );
  }

  return (
    <div className="view-stack">
      <Section title="活動資金帳戶">
        {candidates.length > 1 ? (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>目前有 {candidates.length} 個活動資金候選</MessageBarTitle>
              手機與快速記帳已暫停直接入帳，避免扣錯帳戶。請先保留一個啟用的流動銀行或現金帳戶。
            </MessageBarBody>
          </MessageBar>
        ) : activityFund ? (
          <div className="capture-summary">
            <div><Text size={200}>唯一活動資金</Text><strong>{activityFund.name}</strong></div>
            <div><Text size={200}>類型</Text><strong>{subtypeLabels[activityFund.subtype]}</strong></div>
            <div><Text size={200}>目前餘額</Text><strong>{formatCurrency(activityFund.display_balance)}</strong></div>
          </div>
        ) : (
          <>
            <Text>建立一次即可。之後所有日常支出都從這裡扣除，收入則直接加回；不需要再選帳戶。</Text>
            <form className="form-grid" onSubmit={submit}>
              <Field label="帳戶名稱" required>
                <Input value={name} onChange={(_, data) => setName(data.value)} />
              </Field>
              <Field label="形式" required>
                <Select value={subtype} onChange={(event) => setSubtype(event.target.value)}>
                  <option value="bank">銀行</option>
                  <option value="cash">現金</option>
                </Select>
              </Field>
              <Field label="機構（選填）">
                <Input value={institution} onChange={(_, data) => setInstitution(data.value)} />
              </Field>
              <div className="form-actions">
                <Button type="submit" appearance="primary" icon={<Add24Regular />} disabled={!name.trim()}>
                  建立唯一帳戶
                </Button>
              </div>
            </form>
          </>
        )}
      </Section>

      {otherPersonal.length ? (
        <Section title="其他既有帳戶">
          <MessageBar intent="warning">
            <MessageBarBody>
              這些帳戶保留歷史資料，但不會被手機或快速記帳當成活動資金，也不會自動刪除或合併。
            </MessageBarBody>
          </MessageBar>
          <div className="table-scroll">
            <Table aria-label="其他既有帳戶">
              <TableHeader><TableRow><TableHeaderCell>帳戶</TableHeaderCell><TableHeaderCell>類型</TableHeaderCell><TableHeaderCell>帳面餘額</TableHeaderCell></TableRow></TableHeader>
              <TableBody>{otherPersonal.map((account) => <TableRow key={account.id}>
                <TableCell><strong>{account.name}</strong></TableCell>
                <TableCell>{subtypeLabels[account.subtype] ?? account.subtype}</TableCell>
                <TableCell className="number-cell">{formatCurrency(account.display_balance)}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </div>
        </Section>
      ) : null}
    </div>
  );
}
