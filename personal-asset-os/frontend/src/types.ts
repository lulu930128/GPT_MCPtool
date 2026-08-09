export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense" | "clearing";
export type DecimalValue = string | number;

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
  average_cost: DecimalValue;
  cost_basis: DecimalValue;
  realized_pnl: DecimalValue;
  price: DecimalValue | null;
  price_at: string | null;
  price_provider: string | null;
  price_quality: string | null;
  price_age_days: number | null;
  market_value: DecimalValue | null;
  unrealized_pnl: DecimalValue | null;
  valuation_status: "missing" | "stale" | "manual";
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
  source: string;
  status: string;
  reversal_of_id: string | null;
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
    unpriced_investment_cost: DecimalValue;
    monthly_income: DecimalValue;
    monthly_expense: DecimalValue;
    unresolved_count: number;
    unresolved_total: DecimalValue;
  };
  valuation: {
    price_as_of_min: string | null;
    price_as_of_max: string | null;
    missing_count: number;
    stale_count: number;
    policy: string;
  };
  warnings: string[];
  accounts: Account[];
  positions: Position[];
  reconciliations: Reconciliation[];
  recent_transactions: RecentTransaction[];
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
