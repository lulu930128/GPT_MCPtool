import {
  Badge,
  Button,
  Caption1,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
} from "@fluentui/react-components";
import { Checkmark24Regular, Delete24Regular, Save24Regular } from "@fluentui/react-icons";
import { useMemo, useState } from "react";
import { activityFundCandidates } from "../activity-fund";
import { api, ApiError } from "../api";
import { formatDate } from "../format";
import type { Account, FinancialEvent, FinancialEventFinalizeResult } from "../types";
import { EmptyState, Section } from "./Common";

interface Draft {
  amount: string;
  description: string;
}

function draftFor(event: FinancialEvent, previous?: Draft): Draft {
  return previous ?? {
    amount: String(event.amount),
    description: event.description,
  };
}

export function PendingEventsView({
  events,
  accounts,
  onChanged,
}: {
  events: FinancialEvent[];
  accounts: Account[];
  onChanged: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    intent: "success" | "error";
    title: string;
    body: string;
  } | null>(null);

  const activityFundAccounts = useMemo(() => activityFundCandidates(accounts), [accounts]);
  const activityFund = activityFundAccounts.length === 1 ? activityFundAccounts[0] : null;

  function updateDraft(event: FinancialEvent, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [event.id]: { ...draftFor(event, current[event.id]), ...patch },
    }));
  }

  function errorMessage(caught: unknown): string {
    return caught instanceof ApiError
      ? `${caught.message} (${caught.code})`
      : caught instanceof Error
        ? caught.message
        : "操作失敗";
  }

  async function save(event: FinancialEvent) {
    const draft = drafts[event.id];
    if (!draft) return;
    setBusyId(event.id);
    setMessage(null);
    try {
      await api.patch<FinancialEvent>(`/api/financial-events/${event.id}`, {
        expected_version: event.version,
        amount: draft.amount,
        description: draft.description,
      });
      setMessage({ intent: "success", title: "已更新", body: "日常記錄已保存新版本。" });
      await onChanged();
    } catch (caught) {
      setMessage({ intent: "error", title: "無法更新", body: errorMessage(caught) });
    } finally {
      setBusyId(null);
    }
  }

  async function finalize(event: FinancialEvent) {
    if (!activityFund) return;
    setBusyId(event.id);
    setMessage(null);
    try {
      await api.post<FinancialEventFinalizeResult>(`/api/financial-events/${event.id}/finalize`, {
        expected_version: event.version,
        payment_account_id: event.event_kind === "expense" ? activityFund.id : null,
        destination_account_id: event.event_kind === "income" ? activityFund.id : null,
      });
      setMessage({ intent: "success", title: "已正式入帳", body: event.description });
      await onChanged();
    } catch (caught) {
      setMessage({ intent: "error", title: "無法入帳", body: errorMessage(caught) });
    } finally {
      setBusyId(null);
    }
  }

  async function reject(event: FinancialEvent) {
    if (!window.confirm(`確定不處理「${event.description}」？記錄會保留為已拒絕。`)) return;
    setBusyId(event.id);
    setMessage(null);
    try {
      await api.post<FinancialEvent>(`/api/financial-events/${event.id}/reject`, {
        expected_version: event.version,
        reason: "使用者在待處理匣拒絕",
      });
      setMessage({ intent: "success", title: "已移出待處理", body: "拒絕紀錄仍保留供追溯。" });
      await onChanged();
    } catch (caught) {
      setMessage({ intent: "error", title: "無法拒絕", body: errorMessage(caught) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="view-stack">
      {message ? (
        <MessageBar intent={message.intent}>
          <MessageBarBody><MessageBarTitle>{message.title}</MessageBarTitle>{message.body}</MessageBarBody>
        </MessageBar>
      ) : null}
      <Section title={`待處理日常記錄（${events.length}）`}>
        {events.length === 0 ? (
          <EmptyState title="目前沒有待處理" body="日常記錄都已入帳或完成整理。" />
        ) : (
          <div className="pending-list">
            {events.map((event) => {
              const draft = draftFor(event, drafts[event.id]);
              const dirty =
                draft.amount !== String(event.amount) || draft.description !== event.description;
              const finalizable =
                (event.event_kind === "expense" || event.event_kind === "income") &&
                Boolean(activityFund) &&
                !dirty;
              return (
                <article className="pending-item" key={event.id}>
                  <div className="pending-meta">
                    <Badge appearance="tint">
                      {event.event_kind === "expense" ? "支出" : event.event_kind === "income" ? "收入" : "需整理"}
                    </Badge>
                    <Caption1>{formatDate(event.occurred_at)}</Caption1>
                    <Caption1>版本 {event.version}</Caption1>
                  </div>
                  <div className="pending-fields">
                    <Field label="金額">
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={draft.amount}
                        onChange={(_, data) => updateDraft(event, { amount: data.value })}
                        contentBefore="NT$"
                      />
                    </Field>
                    <Field label="描述">
                      <Input
                        value={draft.description}
                        onChange={(_, data) => updateDraft(event, { description: data.value })}
                      />
                    </Field>
                    <Field label="活動資金帳戶">
                      <Input readOnly value={activityFund?.name ?? "尚未設定唯一活動資金"} />
                    </Field>
                  </div>
                  <div className="pending-actions">
                    <Text size={200}>
                      {dirty ? "先儲存修改，才能使用最新版本入帳。" : "入帳後會建立不可直接覆寫的正式交易。"}
                    </Text>
                    <div>
                      <Button
                        icon={<Save24Regular />}
                        disabled={!dirty || busyId === event.id}
                        onClick={() => void save(event)}
                      >
                        儲存修改
                      </Button>
                      <Button
                        appearance="primary"
                        icon={<Checkmark24Regular />}
                        disabled={!finalizable || busyId === event.id}
                        onClick={() => void finalize(event)}
                      >
                        正式入帳
                      </Button>
                      <Button
                        appearance="subtle"
                        icon={<Delete24Regular />}
                        disabled={busyId === event.id}
                        onClick={() => void reject(event)}
                      >
                        不處理
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
