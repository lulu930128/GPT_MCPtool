import {
  Button,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
} from "@fluentui/react-components";
import { Checkmark24Regular } from "@fluentui/react-icons";
import { useMemo, useRef, useState } from "react";
import { activityFundCandidates } from "../activity-fund";
import { api, ApiError } from "../api";
import { localDateTimeValue, toIso } from "../format";
import type {
  Account,
  FinancialEvent,
  FinancialEventFinalizeResult,
  FinancialEventKind,
} from "../types";
import { Section } from "./Common";

export function QuickCapture({
  accounts,
  onChanged,
}: {
  accounts: Account[];
  onChanged: () => Promise<void>;
}) {
  const amountRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<FinancialEventKind>("expense");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [merchant, setMerchant] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(localDateTimeValue());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    intent: "success" | "warning" | "error";
    title: string;
    body: string;
  } | null>(null);
  const candidates = useMemo(() => activityFundCandidates(accounts), [accounts]);
  const activityFund = candidates.length === 1 ? candidates[0] : null;

  function resetForm() {
    setAmount("");
    setDescription("");
    setMerchant("");
    setNote("");
    setOccurredAt(localDateTimeValue());
    window.setTimeout(() => amountRef.current?.focus(), 0);
  }

  async function capture() {
    const parsedAmount = Number(amount);
    if (!activityFund || !description.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
    setBusy(true);
    setMessage(null);
    const eventId = crypto.randomUUID();
    try {
      const created = await api.post<FinancialEvent>("/api/financial-events", {
        id: eventId,
        event_kind: kind,
        occurred_at: toIso(occurredAt),
        amount,
        currency: "TWD",
        description,
        merchant: merchant || null,
        note: note || null,
        idempotency_key: `quick-capture:${eventId}`,
      });
      try {
        await api.post<FinancialEventFinalizeResult>(
          `/api/financial-events/${created.id}/finalize`,
          {
            expected_version: created.version,
            payment_account_id: kind === "expense" ? activityFund.id : null,
            destination_account_id: kind === "income" ? activityFund.id : null,
          },
        );
        setMessage({
          intent: "success",
          title: kind === "expense" ? "已從活動資金扣除" : "已加入活動資金",
          body: `${description.trim()}已建立為正式平衡交易。`,
        });
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : "正式入帳失敗";
        setMessage({
          intent: "warning",
          title: "記錄已安全保存",
          body: `正式入帳未完成，已留在待處理匣：${detail}`,
        });
      }
      resetForm();
      await onChanged();
    } catch (caught) {
      const detail =
        caught instanceof ApiError
          ? `${caught.message} (${caught.code})`
          : caught instanceof Error
            ? caught.message
            : "無法保存日常記錄";
      setMessage({ intent: "error", title: "沒有保存", body: detail });
    } finally {
      setBusy(false);
    }
  }

  const valid = Boolean(description.trim()) && Number(amount) > 0;
  return (
    <Section title="快速記一筆">
      <div className="capture-kind" role="group" aria-label="記錄類型">
        <Button appearance={kind === "expense" ? "primary" : "subtle"} onClick={() => setKind("expense")}>支出</Button>
        <Button appearance={kind === "income" ? "primary" : "subtle"} onClick={() => setKind("income")}>收入</Button>
      </div>
      {!activityFund ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{candidates.length ? "活動資金帳戶不唯一" : "尚未建立活動資金帳戶"}</MessageBarTitle>
            請先到「帳戶」完成設定；系統不會自行猜測要扣哪一個帳戶。
          </MessageBarBody>
        </MessageBar>
      ) : (
        <Text className="capture-help">
          活動資金：{activityFund.name}。{kind === "expense" ? "這筆會直接扣除。" : "這筆會直接增加。"}
        </Text>
      )}
      <form className="quick-capture-form" onSubmit={(event) => { event.preventDefault(); void capture(); }}>
        <Field label="金額" required>
          <Input ref={amountRef} autoFocus inputMode="decimal" min="0" step="any" type="number" value={amount} onChange={(_, data) => setAmount(data.value)} contentBefore="NT$" />
        </Field>
        <Field label="描述" required>
          <Input value={description} onChange={(_, data) => setDescription(data.value)} placeholder="例如：拉麵" />
        </Field>
        <div className="capture-actions">
          <Button type="submit" appearance="primary" icon={<Checkmark24Regular />} disabled={!valid || !activityFund || busy}>
            {kind === "expense" ? "支出入帳" : "收入入帳"}
          </Button>
        </div>
      </form>
      <details className="capture-more">
        <summary>更多資料</summary>
        <div className="capture-more-grid">
          <Field label="發生時間"><Input type="datetime-local" value={occurredAt} onChange={(_, data) => setOccurredAt(data.value)} /></Field>
          <Field label="店家"><Input value={merchant} onChange={(_, data) => setMerchant(data.value)} /></Field>
          <Field label="備註"><Input value={note} onChange={(_, data) => setNote(data.value)} /></Field>
        </div>
      </details>
      {message ? (
        <MessageBar intent={message.intent} className="capture-message">
          <MessageBarBody><MessageBarTitle>{message.title}</MessageBarTitle>{message.body}</MessageBarBody>
        </MessageBar>
      ) : null}
      <Caption1 className="capture-boundary">日常收支固定使用唯一活動資金；凱基持倉只提供唯讀估值，不會被扣款。</Caption1>
    </Section>
  );
}
