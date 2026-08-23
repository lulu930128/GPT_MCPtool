export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense" | "clearing";
export type DecimalValue = string | number;

export interface MobileUsbTransportStatus {
  schema_version: "paos.mobile_usb_transport.v1";
  enabled: boolean;
  status:
    | "disabled"
    | "starting"
    | "adb_unavailable"
    | "waiting_for_device"
    | "device_unauthorized"
    | "device_offline"
    | "multiple_devices"
    | "reverse_ready"
    | "repair_failed"
    | "probe_failed";
  ready: boolean;
  configured_device: boolean;
  device_count: number;
  last_checked_at: string | null;
  last_ready_at: string | null;
  error_code: string | null;
}

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  subtype: string;
  institution: string | null;
  currency: string;
  is_liquid: boolean;
  is_active: boolean;
  is_system: boolean;
  balance: DecimalValue;
  display_balance: DecimalValue;
}

export interface Position {
  instrument_id: string;
  symbol: string;
  market: string;
  name: string;
  investment_account_id: string;
  investment_account_name: string;
  quantity: DecimalValue;
  average_cost: DecimalValue | null;
  cost_basis: DecimalValue | null;
  realized_pnl: DecimalValue | null;
  price: DecimalValue | null;
  price_at: string | null;
  price_provider: string | null;
  price_quality: string | null;
  price_age_days: number | null;
  market_value: DecimalValue | null;
  unrealized_pnl: DecimalValue | null;
  valuation_status:
    | "missing"
    | "stale"
    | "manual"
    | "broker_live"
    | "broker_stale"
    | "broker_derived"
    | "ledger_only";
  position_source: "ledger" | "kgi_broker";
  valuation_included: boolean;
  reconciliation_status:
    | "not_applicable"
    | "matched"
    | "quantity_mismatch"
    | "broker_only"
    | "unmapped"
    | "ledger_only";
  ledger_quantity: DecimalValue | null;
  broker_unrealized_pnl: DecimalValue | null;
  native_currency: string;
  native_price: DecimalValue | null;
  native_market_value: DecimalValue | null;
  settlement_currency: string | null;
  fx_rate: DecimalValue | null;
  fx_at: string | null;
  fx_provider: string | null;
  fx_quality: string | null;
}

export interface Instrument {
  id: string;
  symbol: string;
  market: string;
  name: string;
  asset_class: string;
  currency: string;
}

export interface RecentTransaction {
  id: string;
  occurred_at: string;
  description: string;
  category: string | null;
  note: string | null;
  category_source: string | null;
  source: string;
  status: string;
  reversal_of_id: string | null;
}

export interface ReviewCompositionItem {
  key: string;
  label: string;
  amount: DecimalValue;
  share_percent: DecimalValue;
  market: string | null;
  symbol: string | null;
  label_source: string;
  valuation_status?: string;
  position_source?: string;
}

export interface ReviewComposition {
  status: "complete" | "partial" | "empty" | "unavailable";
  currency: "TWD";
  total: DecimalValue;
  item_count: number;
  chart_items: ReviewCompositionItem[];
  table_items: ReviewCompositionItem[];
  excluded_count: number;
  excluded_amount: DecimalValue;
  chart_policy: "top_5_plus_other";
  policy: string;
}

export interface SpendingComposition extends ReviewComposition {
  start_at: string;
  end_at: string;
  transaction_count: number;
}

export type ReviewSpendingRange = "1m" | "3m" | "1y";

export interface DashboardReview {
  schema_version: "paos.dashboard_review.v1";
  as_of: string;
  base_currency: "TWD";
  reporting_timezone: string;
  summary: {
    gross_assets: DecimalValue;
    debt: DecimalValue;
    provisional_net_worth: DecimalValue;
    unpriced_investment_cost: DecimalValue;
  };
  asset_allocation: ReviewComposition;
  stock_allocation: ReviewComposition;
  spending: {
    default_range: ReviewSpendingRange;
    ranges: Record<ReviewSpendingRange, SpendingComposition>;
    range_semantics: Record<ReviewSpendingRange, string>;
  };
}

export type FinancialEventKind = "expense" | "income" | "transfer" | "unknown";
export type FinancialEventStatus =
  | "pending_match"
  | "needs_review"
  | "matched"
  | "rejected"
  | "superseded";

export interface FinancialEvent {
  id: string;
  event_kind: FinancialEventKind;
  occurred_at: string;
  captured_at: string;
  amount: DecimalValue;
  currency: string;
  description: string;
  merchant: string | null;
  note: string | null;
  category_hint: string | null;
  payment_hint: string | null;
  source: string;
  status: FinancialEventStatus;
  version: number;
  payload_hash: string;
  approval_source: "local_ui" | "paired_mobile" | null;
  approved_at: string | null;
  matched_at: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  created_at: string;
  updated_at: string;
  transaction_ids: string[];
  created?: boolean;
}

export interface FinancialEventFinalizeResult {
  event: FinancialEvent;
  transaction: { id: string; created: boolean };
  created: boolean;
}

export interface Reconciliation {
  id: string;
  account_id: string;
  account_name: string;
  observed_at: string;
  source: string;
  reported_balance: DecimalValue;
  ledger_balance: DecimalValue;
  difference: DecimalValue;
  reconciled: boolean;
  unresolved: boolean;
}

export interface Dashboard {
  as_of: string;
  base_currency: string;
  quality: string;
  capture: {
    pending_count: number;
    needs_review_count: number;
    pending_amount: DecimalValue;
  };
  metrics: {
    provisional_net_worth: DecimalValue;
    known_net_worth: DecimalValue;
    non_investment_assets: DecimalValue;
    liquid_cash: DecimalValue;
    debt: DecimalValue;
    reserved_cash: DecimalValue;
    available_cash: DecimalValue;
    investment_book_value: DecimalValue;
    investment_market_value: DecimalValue;
    broker_market_value: DecimalValue;
    broker_position_count: number;
    broker_unreconciled_count: number;
    unpriced_investment_cost: DecimalValue;
    monthly_income: DecimalValue;
    monthly_expense: DecimalValue;
    unresolved_count: number;
    unresolved_total: DecimalValue;
  };
  broker: {
    schema_version: "paos.broker_valuation.v2";
    enabled: boolean;
    status: "disabled" | "unavailable" | "complete" | "partial" | "explicit_empty" | "stale";
    read_mode: "disabled" | "live" | "memory_cache" | "memory_fallback" | "unavailable";
    broker: "KGI";
    account: {
      market: "TW" | "US";
      opaque_id: string;
      masked_label: string;
      ledger_account_id: string | null;
      status: "complete" | "explicit_empty" | "unavailable";
    } | null;
    accounts: Array<{
      market: "TW" | "US";
      opaque_id: string;
      masked_label: string;
      ledger_account_id: string | null;
      status: "complete" | "explicit_empty";
    }>;
    markets: Array<{
      market: "TW" | "US";
      status: "complete" | "explicit_empty" | "unavailable";
      source: "kgi.inventory_sum" | "kgi.stock_position_report";
      source_as_of: string | null;
      position_count: number;
      valuation_count: number;
      error_code: string | null;
    }>;
    captured_at: string | null;
    source_as_of: string | null;
    market_value: DecimalValue;
    native_market_values: Record<string, DecimalValue>;
    fx: {
      status: "complete" | "stale" | "unavailable";
      read_mode: "live" | "memory_cache" | "memory_fallback" | "unavailable";
      base_currency?: "USD";
      quote_currency?: "TWD";
      rate?: DecimalValue;
      effective_at?: string;
      provider?: "taifex.daily_fx" | "cbc.bp01d01" | "bot.spot_mid";
      quality?: "official_reference" | "official_close" | "bank_spot_mid";
      effective_precision?: "date" | "datetime";
    } | null;
    position_count: number;
    matched_count: number;
    quantity_mismatch_count: number;
    broker_only_count: number;
    unmapped_count: number;
    ledger_only_count: number;
    policy: string;
  };
  valuation: {
    price_as_of_min: string | null;
    price_as_of_max: string | null;
    missing_count: number;
    stale_count: number;
    policy: string;
  };
  warnings: string[];
  review: DashboardReview;
  accounts: Account[];
  positions: Position[];
  reconciliations: Reconciliation[];
  recent_transactions: RecentTransaction[];
}

export type DashboardHistoryRange = "1m" | "3m" | "1y";

export interface DailyValuationPoint {
  id: string;
  date: string;
  reporting_timezone: string;
  as_of: string;
  captured_at: string;
  base_currency: string;
  quality: string;
  provisional: boolean;
  metrics: {
    provisional_net_worth: DecimalValue;
    known_net_worth: DecimalValue;
    non_investment_assets: DecimalValue;
    liquid_cash: DecimalValue;
    available_cash: DecimalValue;
    debt: DecimalValue;
    investment_book_value: DecimalValue;
    investment_market_value: DecimalValue;
    unpriced_investment_cost: DecimalValue;
    broker_market_value: DecimalValue | null;
  };
  valuation: {
    price_as_of_min?: string | null;
    price_as_of_max?: string | null;
    missing_count?: number;
    stale_count?: number;
    policy?: string;
  };
  broker: {
    status?: string;
    source_as_of?: string | null;
  };
  warnings: string[];
  calculation_version: string;
}

export interface DashboardHistory {
  schema_version: 1;
  range: DashboardHistoryRange;
  start_date: string;
  end_date: string;
  reporting_timezone: string;
  base_currency: string;
  series: DailyValuationPoint[];
  coverage: {
    expected_calendar_days: number;
    point_count: number;
    missing_calendar_days: number;
    first_date: string | null;
    last_date: string | null;
    gap_policy: "missing_dates_are_omitted_not_zero_filled";
  };
}

export interface Snapshot {
  id: string;
  period_key: string;
  as_of: string;
  price_as_of: string | null;
  calculation_version: string;
  created_at: string;
}

export interface ApiErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}
