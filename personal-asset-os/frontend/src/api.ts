import type {
  Account,
  ApiErrorEnvelope,
  Dashboard,
  DashboardHistory,
  DashboardHistoryRange,
  FinancialEvent,
  Instrument,
  MobileUsbTransportStatus,
  Snapshot,
} from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let body: ApiErrorEnvelope;
    try {
      body = (await response.json()) as ApiErrorEnvelope;
    } catch {
      body = {};
    }
    throw new ApiError(
      body.error?.message ?? `Request failed (${response.status})`,
      body.error?.code ?? "HTTP_ERROR",
      response.status,
    );
  }
  return (await response.json()) as T;
}

export const api = {
  dashboard: () => request<Dashboard>("/api/dashboard"),
  dashboardHistory: (range: DashboardHistoryRange) =>
    request<DashboardHistory>(`/api/dashboard/history?range=${range}`),
  accounts: () => request<Account[]>("/api/accounts"),
  instruments: () => request<Instrument[]>("/api/instruments"),
  snapshots: () => request<Snapshot[]>("/api/snapshots"),
  financialEvents: () =>
    request<FinancialEvent[]>(
      "/api/financial-events?status=pending_match&status=needs_review&limit=100",
    ),
  mobileTransport: () => request<MobileUsbTransportStatus>("/api/mobile/transport"),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
};
