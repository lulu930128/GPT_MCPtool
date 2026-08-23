import {
  Badge,
  Button,
  Caption1,
  Text,
} from "@fluentui/react-components";
import {
  CheckmarkCircle20Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
  DismissCircle20Regular,
  Info20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import { useMemo, useState, type ReactNode } from "react";

type NoticeTone = "error" | "warning" | "info" | "success";

interface StatusNotice {
  id: string;
  tone: NoticeTone;
  title: string;
  body: string;
}

function warningNotice(warning: string, index: number): StatusNotice {
  if (warning.startsWith("mobile_usb_bridge:")) {
    const status = warning.split(":", 2)[1] ?? "";
    const copies: Record<string, Omit<StatusNotice, "id">> = {
      starting: { tone: "info", title: "手機 USB 同步", body: "正在檢查已配對手機與 USB 通道。" },
      waiting_for_device: { tone: "info", title: "手機 USB 同步", body: "目前沒有接上指定手機；手機記錄會留在本機等待。" },
      device_unauthorized: { tone: "warning", title: "手機尚未授權", body: "請在手機確認這台電腦的 USB 偵錯授權。" },
      device_offline: { tone: "warning", title: "手機 ADB 離線", body: "USB 已偵測但手機尚未進入可用狀態。" },
      multiple_devices: { tone: "warning", title: "偵測到多台 Android 裝置", body: "PAOS 不會猜測目標，請在本機設定指定裝置。" },
      adb_unavailable: { tone: "error", title: "ADB 工具不可用", body: "PAOS 找不到本機設定的 adb.exe，手機同步自動修復暫停。" },
      repair_failed: { tone: "error", title: "USB 通道修復失敗", body: "ADB 已連線，但無法建立或驗證固定的 18876 mapping。" },
      probe_failed: { tone: "error", title: "USB 通道檢查失敗", body: "PAOS 暫時無法讀取 ADB 裝置或 reverse 狀態。" },
    };
    return { id: `warning:${index}:${warning}`, ...(copies[status] ?? { tone: "warning", title: "手機 USB 同步", body: "USB 通道目前未就緒。" }) };
  }
  if (warning === "one_shot_worker_session") {
    return {
      id: `warning:${index}:${warning}`,
      tone: "info",
      title: "凱基即時連線",
      body: "持倉會在讀取時建立一次安全連線，重新整理可能需要幾秒鐘。",
    };
  }
  if (warning === "source_as_of_inferred_from_capture_time") {
    return {
      id: `warning:${index}:${warning}`,
      tone: "info",
      title: "資料時間來源",
      body: "凱基未提供獨立更新時間，目前以本次持倉讀取完成時間標示。",
    };
  }
  if (warning.startsWith("odd_lot_overlap_removed_from_cash:")) {
    const symbol = warning.split(":", 2)[1] || "台股持倉";
    return {
      id: `warning:${index}:${warning}`,
      tone: "info",
      title: "持倉數量已校正",
      body: `${symbol} 的現股與零股數量重疊，已依券商市值校正，不會寫入正式帳本。`,
    };
  }
  return {
    id: `warning:${index}:${warning}`,
    tone: "warning",
    title: "資料提醒",
    body: warning,
  };
}

function toneIcon(tone: NoticeTone): ReactNode {
  if (tone === "error") return <DismissCircle20Regular />;
  if (tone === "warning") return <Warning20Regular />;
  if (tone === "success") return <CheckmarkCircle20Regular />;
  return <Info20Regular />;
}

function toneLabel(tone: NoticeTone): string {
  if (tone === "error") return "錯誤";
  if (tone === "warning") return "注意";
  if (tone === "success") return "完成";
  return "資訊";
}

export function DataStatusPanel({
  warnings,
  error,
  success,
  loading,
  onRefresh,
}: {
  warnings: string[];
  error: string | null;
  success: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const notices = useMemo(() => {
    const result: StatusNotice[] = [];
    if (error) {
      result.push({ id: "app:error", tone: "error", title: "操作未完成", body: error });
    }
    if (success) {
      result.push({ id: "app:success", tone: "success", title: "完成", body: success });
    }
    [...new Set(warnings)].forEach((warning, index) => {
      result.push(warningNotice(warning, index));
    });
    return result;
  }, [error, success, warnings]);

  const errorCount = notices.filter((notice) => notice.tone === "error").length;
  const warningCount = notices.filter((notice) => notice.tone === "warning").length;
  const summary = loading
    ? { label: "更新中", color: "informative" as const }
    : errorCount
      ? { label: `錯誤 ${errorCount}`, color: "danger" as const }
      : warningCount
        ? { label: `提醒 ${warningCount}`, color: "warning" as const }
        : notices.length
          ? { label: `資訊 ${notices.length}`, color: "informative" as const }
          : { label: "正常", color: "success" as const };

  return (
    <section className="data-status-panel" aria-label="更新狀態">
      <div className="data-status-heading">
        <button
          type="button"
          className="data-status-toggle"
          aria-expanded={open}
          aria-controls="data-status-content"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="data-status-title">
            {open ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
            <span>更新狀態</span>
          </span>
          <span className="data-status-summary">
            {!loading && notices.length > warningCount + errorCount ? (
              <Caption1>{notices.length} 項</Caption1>
            ) : null}
            <Badge appearance="tint" color={summary.color}>{summary.label}</Badge>
          </span>
        </button>
        <Button appearance="subtle" size="small" onClick={onRefresh} disabled={loading}>
          重新整理
        </Button>
      </div>
      {open ? (
        <div id="data-status-content" className="data-status-content">
          {notices.length ? (
            <div className="data-status-list">
              {notices.map((notice) => (
                <article className={`data-status-item tone-${notice.tone}`} key={notice.id}>
                  <span className="data-status-icon" aria-hidden="true">{toneIcon(notice.tone)}</span>
                  <div className="data-status-copy">
                    <div>
                      <Text weight="semibold">{notice.title}</Text>
                      <Badge appearance="outline" color={notice.tone === "error" ? "danger" : notice.tone === "warning" ? "warning" : notice.tone === "success" ? "success" : "informative"}>
                        {toneLabel(notice.tone)}
                      </Badge>
                    </div>
                    <Caption1>{notice.body}</Caption1>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="data-status-empty">
              <CheckmarkCircle20Regular aria-hidden="true" />
              <span>目前沒有需要處理的資料提醒。</span>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
