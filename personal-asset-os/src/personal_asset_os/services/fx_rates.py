from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from datetime import time as wall_time
from decimal import Decimal, InvalidOperation
from typing import Literal, Protocol
from zoneinfo import ZoneInfo

import httpx

from personal_asset_os.settings import Settings
from personal_asset_os.temporal import ensure_utc, utc_now


@dataclass(frozen=True, slots=True)
class FxRateFact:
    base_currency: Literal["USD"]
    quote_currency: Literal["TWD"]
    rate: Decimal
    effective_at: datetime
    retrieved_at: datetime
    provider: Literal["taifex.daily_fx", "cbc.bp01d01", "bot.spot_mid"]
    quality: Literal["official_reference", "official_close", "bank_spot_mid"]
    effective_precision: Literal["date", "datetime"] = "datetime"
    spot_buy: Decimal | None = None
    spot_sell: Decimal | None = None


@dataclass(frozen=True, slots=True)
class FxReadResult:
    status: Literal["complete", "stale", "unavailable"]
    read_mode: Literal["live", "memory_cache", "memory_fallback", "unavailable"]
    retrieved_at: datetime
    fact: FxRateFact | None = None
    warnings: tuple[str, ...] = ()

    @classmethod
    def unavailable(
        cls, *, now: datetime, warnings: tuple[str, ...]
    ) -> FxReadResult:
        return cls(
            status="unavailable",
            read_mode="unavailable",
            retrieved_at=ensure_utc(now),
            warnings=warnings,
        )


class FxRateProvider(Protocol):
    def read(self, *, now: datetime | None = None) -> FxReadResult: ...


class OfficialUsdTwdRateProvider:
    def __init__(
        self,
        settings: Settings,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._enabled = settings.fx_enabled
        self._taifex_url = settings.fx_taifex_url
        self._cbc_url = settings.fx_cbc_url
        self._bot_url = settings.fx_bot_url
        self._timeout = settings.fx_timeout_seconds
        self._cache_ttl = settings.fx_cache_ttl_seconds
        self._fallback_ttl = settings.fx_memory_fallback_seconds
        self._max_rate_age = settings.fx_rate_max_age_seconds
        self._transport = transport
        self._lock = threading.Lock()
        self._cached: FxReadResult | None = None
        self._cached_monotonic: float | None = None

    def read(self, *, now: datetime | None = None) -> FxReadResult:
        checked_at = ensure_utc(now or utc_now())
        if not self._enabled:
            return FxReadResult.unavailable(
                now=checked_at, warnings=("USD/TWD 匯率讀取已停用",)
            )
        with self._lock:
            monotonic_now = time.monotonic()
            cache_age = self._cache_age(monotonic_now)
            if self._cached and cache_age is not None and cache_age <= self._cache_ttl:
                return FxReadResult(
                    status=self._cached.status,
                    read_mode="memory_cache",
                    retrieved_at=checked_at,
                    fact=self._cached.fact,
                    warnings=self._cached.warnings,
                )
            try:
                result = self._read_live(checked_at)
            except Exception:
                if (
                    self._cached
                    and self._cached.fact is not None
                    and cache_age is not None
                    and cache_age <= self._fallback_ttl
                    and self._fact_age(self._cached.fact, checked_at) <= self._max_rate_age
                ):
                    return FxReadResult(
                        status="stale",
                        read_mode="memory_fallback",
                        retrieved_at=checked_at,
                        fact=self._cached.fact,
                        warnings=self._cached.warnings
                        + ("官方匯率讀取失敗，暫用本次 PAOS 程序記憶體內的上次成功匯率",),
                    )
                return FxReadResult.unavailable(
                    now=checked_at,
                    warnings=(
                        "期交所、央行與臺灣銀行官方匯率目前均無法讀取；USD 部位未換算為 TWD",
                    ),
                )
            self._cached = result
            self._cached_monotonic = monotonic_now
            return result

    def _cache_age(self, monotonic_now: float) -> float | None:
        if self._cached_monotonic is None:
            return None
        return max(monotonic_now - self._cached_monotonic, 0.0)

    def _read_live(self, checked_at: datetime) -> FxReadResult:
        warnings: list[str] = []
        with httpx.Client(
            timeout=self._timeout,
            transport=self._transport,
            trust_env=False,
            follow_redirects=True,
        ) as client:
            try:
                response = client.get(self._taifex_url)
                response.raise_for_status()
                fact = parse_taifex_usd_twd(response.json(), retrieved_at=checked_at)
                if self._fact_age(fact, checked_at) <= self._max_rate_age:
                    return FxReadResult(
                        status="complete",
                        read_mode="live",
                        retrieved_at=checked_at,
                        fact=fact,
                        warnings=(
                            "期交所匯率只提供生效日期；16:00 Asia/Taipei 僅作 freshness 邊界，"
                            "不代表精確發布時間",
                        ),
                    )
                warnings.append("期交所 USD/NTD 每日參考匯率已超過允許時效")
            except Exception:
                warnings.append("期交所 USD/NTD 每日參考匯率讀取或解析失敗")

            try:
                response = client.get(self._cbc_url)
                response.raise_for_status()
                fact = parse_cbc_usd_twd(response.json(), retrieved_at=checked_at)
                if self._fact_age(fact, checked_at) <= self._max_rate_age:
                    return FxReadResult(
                        status="complete",
                        read_mode="live",
                        retrieved_at=checked_at,
                        fact=fact,
                    )
                warnings.append("央行 NTD/USD 日資料已超過允許時效，未用於目前資產換算")
            except Exception:
                warnings.append("央行 NTD/USD 日資料讀取或解析失敗")

            response = client.get(self._bot_url)
            response.raise_for_status()
            fact = parse_bot_usd_twd(response.text, retrieved_at=checked_at)
        return FxReadResult(
            status="complete",
            read_mode="live",
            retrieved_at=checked_at,
            fact=fact,
            warnings=tuple(warnings)
            + ("臺銀文字牌告未提供可驗證生效時間，使用本次擷取時間並標示為銀行即期中價",),
        )

    @staticmethod
    def _fact_age(fact: FxRateFact, checked_at: datetime) -> float:
        return max((checked_at - ensure_utc(fact.effective_at)).total_seconds(), 0.0)


def parse_cbc_usd_twd(payload: object, *, retrieved_at: datetime) -> FxRateFact:
    if not isinstance(payload, dict):
        raise ValueError("CBC payload must be an object")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("CBC data is missing")
    structure = data.get("structure")
    if not isinstance(structure, dict):
        raise ValueError("CBC structure is missing")
    columns = structure.get("Table1")
    rows = data.get("dataSets")
    if not isinstance(columns, list) or not isinstance(rows, list):
        raise ValueError("CBC rows are missing")
    rate_index = next(
        (
            index + 1
            for index, item in enumerate(columns)
            if isinstance(item, dict) and str(item.get("data", "")).strip() == "新台幣NTD/USD"
        ),
        None,
    )
    if rate_index is None:
        raise ValueError("CBC NTD/USD column is missing")
    latest: tuple[datetime, Decimal] | None = None
    taipei = ZoneInfo("Asia/Taipei")
    for row in rows:
        if not isinstance(row, list) or len(row) <= rate_index:
            continue
        try:
            date_value = datetime.strptime(str(row[0]), "%Y%m%d").date()
            rate = _positive_decimal(row[rate_index])
        except (ValueError, TypeError):
            continue
        effective = datetime.combine(date_value, wall_time(16, 0), tzinfo=taipei).astimezone(
            UTC
        )
        if latest is None or effective > latest[0]:
            latest = (effective, rate)
    if latest is None:
        raise ValueError("CBC NTD/USD contains no valid row")
    return FxRateFact(
        base_currency="USD",
        quote_currency="TWD",
        rate=latest[1],
        effective_at=latest[0],
        retrieved_at=ensure_utc(retrieved_at),
        provider="cbc.bp01d01",
        quality="official_close",
    )


def parse_taifex_usd_twd(payload: object, *, retrieved_at: datetime) -> FxRateFact:
    if not isinstance(payload, list):
        raise ValueError("TAIFEX payload must be a list")
    latest: tuple[datetime, Decimal] | None = None
    taipei = ZoneInfo("Asia/Taipei")
    for row in payload:
        if not isinstance(row, dict):
            continue
        try:
            date_value = datetime.strptime(str(row.get("Date", "")), "%Y%m%d").date()
            rate = _positive_decimal(row.get("USD/NTD"))
        except (ValueError, TypeError):
            continue
        effective = datetime.combine(date_value, wall_time(16, 0), tzinfo=taipei).astimezone(
            UTC
        )
        if latest is None or effective > latest[0]:
            latest = (effective, rate)
    if latest is None:
        raise ValueError("TAIFEX USD/NTD contains no valid row")
    return FxRateFact(
        base_currency="USD",
        quote_currency="TWD",
        rate=latest[1],
        effective_at=latest[0],
        retrieved_at=ensure_utc(retrieved_at),
        provider="taifex.daily_fx",
        quality="official_reference",
        effective_precision="date",
    )


def parse_bot_usd_twd(text: str, *, retrieved_at: datetime) -> FxRateFact:
    if "Challenge Validation" in text:
        raise ValueError("BOT challenge response")
    match = re.search(
        r"(?im)^\s*USD\s+Buying\s+([0-9.]+)\s+([0-9.]+).*?Selling\s+([0-9.]+)\s+([0-9.]+)",
        text,
    )
    if match is None:
        raise ValueError("BOT USD spot row is missing")
    spot_buy = _positive_decimal(match.group(2))
    spot_sell = _positive_decimal(match.group(4))
    if spot_buy > spot_sell:
        raise ValueError("BOT USD spread is invalid")
    checked_at = ensure_utc(retrieved_at)
    return FxRateFact(
        base_currency="USD",
        quote_currency="TWD",
        rate=(spot_buy + spot_sell) / Decimal(2),
        effective_at=checked_at,
        retrieved_at=checked_at,
        provider="bot.spot_mid",
        quality="bank_spot_mid",
        spot_buy=spot_buy,
        spot_sell=spot_sell,
    )


def _positive_decimal(value: object) -> Decimal:
    try:
        parsed = Decimal(str(value).strip().replace(",", ""))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("FX value is not a Decimal") from exc
    if not parsed.is_finite() or parsed <= 0:
        raise ValueError("FX value must be finite and positive")
    return parsed
