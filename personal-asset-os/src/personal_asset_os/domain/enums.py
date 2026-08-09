from __future__ import annotations

from enum import StrEnum


class AccountKind(StrEnum):
    ASSET = "asset"
    LIABILITY = "liability"
    EQUITY = "equity"
    INCOME = "income"
    EXPENSE = "expense"
    CLEARING = "clearing"


class AccountSubtype(StrEnum):
    CASH = "cash"
    BANK = "bank"
    CREDIT_CARD = "credit_card"
    BROKER_CASH = "broker_cash"
    INVESTMENT = "investment"
    OPENING_BALANCE = "opening_balance"
    SALARY = "salary"
    GENERAL_EXPENSE = "general_expense"
    INVESTMENT_FEE = "investment_fee"
    REALIZED_PNL = "realized_pnl"
    UNMATCHED = "unmatched"
    OTHER = "other"


class TransactionStatus(StrEnum):
    POSTED = "posted"
    REVERSED = "reversed"


class FinancialEventKind(StrEnum):
    EXPENSE = "expense"
    INCOME = "income"
    TRANSFER = "transfer"
    UNKNOWN = "unknown"


class FinancialEventStatus(StrEnum):
    PENDING_MATCH = "pending_match"
    NEEDS_REVIEW = "needs_review"
    MATCHED = "matched"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"


class ApprovalSource(StrEnum):
    LOCAL_UI = "local_ui"
    PAIRED_MOBILE = "paired_mobile"


class TradeSide(StrEnum):
    BUY = "buy"
    SELL = "sell"


class PriceQuality(StrEnum):
    MANUAL = "manual"
    TRADE_EXECUTION = "trade_execution"
    IMPORTED = "imported"


class AuditAction(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    REJECT = "reject"
    FINALIZE = "finalize"
    REVERSE = "reverse"
    BACKUP = "backup"
    SNAPSHOT = "snapshot"
