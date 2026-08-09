import {
  Button,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Select,
  Text,
} from "@fluentui/react-components";
import { Checkmark24Regular, Save24Regular } from "@fluentui/react-icons";
import { useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { localDateTimeValue, toIso } from "../format";
import type {
  Account,
  FinancialEvent,
  FinancialEventFinalizeResult,
  FinancialEventKind,
} from "../types";
import { Section } from "./Common";

function accountStorageKey(kind: FinancialEventKind): string {
  return `paos.quick-capture.account.${kind}`;
}

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
  const [accountId, setAccountId] = useState(
    () => window.localStorage.getItem(accountStorageKey("expense")) ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    intent: "success" | "warning" | "error";
    title: string;
    body: string;
  } | null>(null);

  const eligibleAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          !account.is_system &&
          account.is_active &&
          (kind === "expense"
            ? account.kind === "asset" || account.kind === "liability"
            : account.kind === "asset"),
      ),
    [accounts, kind],
  );

  const effectiveAccountId = eligibleAccounts.some((account) => account.id === accountId)
    ? accountId
    : "";

  function changeKind(next: FinancialEventKind) {
    setKind(next);
    setAccountId(window.localStorage.getItem(accountStorageKey(next)) ?? "");
  }

  function resetForm() {
    setAmount("");
    setDescription("");
    setMerchant("");
    setNote("");
    setOccurredAt(localDateTimeValue());
    window.setTimeout(() => amountRef.current?.focus(), 0);
  }

  async function capture(finalize: boolean) {
    const parsedAmount = Number(amount);
    if (!description.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
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
      if (finalize && effectiveAccountId) {
        window.localStorage.setItem(accountStorageKey(kind), effectiveAccountId);
        try {
          await api.post<FinancialEventFinalizeResult>(
            `/api/financial-events/${created.id}/finalize`,
            {
              expected_version: created.version,
              payment_account_id: kind === "expense" ? effectiveAccountId : null,
              destination_account_id: kind === "income" ? effectiveAccountId : null,
            },
          );
          setMessage({
            intent: "success",
            title: "已正式入帳",
            body: `${description.trim()}已建立為平衡交易。`,
          });
        } catch (caught) {
          const detail = caught instanceof Error ? caught.message : "正式入帳失敗";
          setMessage({
            intent: "warning",
            title: "記錄已安全保存",
            body: `正式入帳未完成，已留在待處理匣：${detail}`,
          });
        }
      } else {
        setMessage({
          intent: "success",
          title: "已先記著",
          body: "這筆資料尚未影響正式資產與收支，可稍後在待處理匣整理。",
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
  const canFinalize = valid && Boolean(effectiveAccountId);
  return (
    <Section title="快速記一筆">
      <div className="capture-kind" role="group" aria-label="記錄類型">
        <Button
          appearance={kind === "expense" ? "primary" : "subtle"}
          onClick={() => changeKind("expense")}
        >
          支出
        </Button>
        <Button
          appearance={kind === "income" ? "primary" : "subtle"}
          onClick={() => changeKind("income")}
        >
          收入
        </Button>
      </div>
      <form
        className="quick-capture-form"
        onSubmit={(event) => {
          event.preventDefault();
          void capture(canFinalize);
        }}
      >
        <Field label="金額" required>
          <Input
            ref={amountRef}
            autoFocus
            inputMode="decimal"
            min="0"
            step="any"
            type="number"
            value={amount}
            onChange={(_, data) => setAmount(data.value)}
            contentBefore="NT$"
          />
        </Field>
        <Field label="描述" required>
          <Input
            value={description}
            onChange={(_, data) => setDescription(data.value)}
            placeholder="例如：拉麵"
          />
        </Field>
        <Field label={kind === "expense" ? "付款帳戶" : "收款帳戶"}>
          <Select value={effectiveAccountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">稍後再選</option>
            {eligibleAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </Select>
        </Field>
        <div className="capture-actions">
          <Button
            type="button"
            appearance="secondary"
            icon={<Save24Regular />}
            disabled={!valid || busy}
            onClick={() => void capture(false)}
          >
            先記著
          </Button>
          <Button
            type="submit"
            appearance="primary"
            icon={<Checkmark24Regular />}
            disabled={!canFinalize || busy}
          >
            直接入帳
          </Button>
        </div>
      </form>
      {!eligibleAccounts.length ? (
        <Text className="capture-help">現在仍可先記著；建立常用帳戶後就能直接入帳。</Text>
      ) : null}
      <details className="capture-more">
        <summary>更多資料</summary>
        <div className="capture-more-grid">
          <Field label="發生時間">
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(_, data) => setOccurredAt(data.value)}
            />
          </Field>
          <Field label="店家">
            <Input value={merchant} onChange={(_, data) => setMerchant(data.value)} />
          </Field>
          <Field label="備註">
            <Input value={note} onChange={(_, data) => setNote(data.value)} />
          </Field>
        </div>
      </details>
      {message ? (
        <MessageBar intent={message.intent} className="capture-message">
          <MessageBarBody><MessageBarTitle>{message.title}</MessageBarTitle>{message.body}</MessageBarBody>
        </MessageBar>
      ) : null}
      <Caption1 className="capture-boundary">
        「先記著」只保存待處理事件；「直接入帳」才會建立正式雙式交易。
      </Caption1>
    </Section>
  );
}
