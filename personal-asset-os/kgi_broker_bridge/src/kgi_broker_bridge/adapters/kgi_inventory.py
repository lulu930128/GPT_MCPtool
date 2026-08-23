from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from pydantic import ValidationError

from kgi_broker_bridge.contracts import (
    AggregateSnapshotStatus,
    BrokerAccountRef,
    BrokerHealth,
    BrokerInstrumentValuation,
    BrokerInstrumentValuationV2,
    BrokerMarketScopeV2,
    BrokerPosition,
    BrokerPositionSnapshot,
    BrokerPositionSnapshotV2,
    BrokerPositionV2,
    MarketScopeStatus,
    PositionType,
    PriceQuality,
    SnapshotStatus,
)
from kgi_broker_bridge.errors import AmbiguousEmptyInventoryError, SchemaParseError
from kgi_broker_bridge.identity import AccountIdentityProjector
from kgi_broker_bridge.ports import (
    InventoryGateway,
    RawBrokerSnapshotBatch,
    RawInventoryBatch,
    RawMarketInventoryScope,
)

POSITION_FIELDS: tuple[tuple[str, PositionType], ...] = (
    ("NETQTY0", PositionType.CASH),
    ("NETQTY3", PositionType.MARGIN),
    ("NETQTY4", PositionType.SHORT),
    ("NETQTY9", PositionType.ODD_LOT),
)


def _aware_utc(value: datetime, field: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise SchemaParseError(field)
    return value.astimezone(UTC)


def _required_text(value: object, field: str) -> str:
    normalized = str(value).strip() if value is not None else ""
    if not normalized:
        raise SchemaParseError(field)
    return normalized


def _decimal(value: object, field: str) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        result = Decimal(text)
    except (InvalidOperation, ValueError) as exc:
        raise SchemaParseError(field) from exc
    if not result.is_finite():
        raise SchemaParseError(field)
    return result


def _stable(values: list[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(item for item in values if item))


def _normalized_tw_quantities(
    raw: Mapping[str, object],
    *,
    symbol: str,
    last_price: Decimal | None,
    broker_market_value: Decimal | None,
    warnings: list[str],
) -> dict[str, Decimal | None]:
    quantities = {
        field: _decimal(raw.get(field), field) for field, _ in POSITION_FIELDS
    }
    cash = quantities["NETQTY0"]
    odd_lot = quantities["NETQTY9"]
    if (
        cash is None
        or odd_lot is None
        or cash <= 0
        or odd_lot <= 0
        or odd_lot > cash
        or last_price is None
        or broker_market_value is None
        or any(value is not None and value < 0 for value in quantities.values())
    ):
        return quantities

    reported_total = sum(
        (value for value in quantities.values() if value is not None),
        start=Decimal(0),
    )
    total_without_overlap = reported_total - odd_lot
    if (
        total_without_overlap * last_price == broker_market_value
        and reported_total * last_price != broker_market_value
    ):
        quantities["NETQTY0"] = cash - odd_lot
        warnings.append(f"odd_lot_overlap_removed_from_cash:{symbol}")
    return quantities


def _payload_hash(payload: dict[str, object]) -> str:
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def _validation_field(exc: ValidationError, prefix: str) -> str:
    first = exc.errors()[0] if exc.errors() else {"loc": ("contract",)}
    location = ".".join(str(item) for item in first.get("loc", ("contract",)))
    return f"{prefix}.{location}" if location else prefix


def _us_price_as_of(value: object, *, date_only: bool = False) -> datetime | None:
    text = str(value).strip() if value is not None else ""
    if not text:
        return None
    try:
        if date_only:
            parsed = datetime.strptime(text[:8], "%Y%m%d").replace(hour=16)
            parsed = parsed.replace(tzinfo=_new_york_timezone(parsed.date()))
        else:
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                parsed = datetime.strptime(text, "%Y%m%d%H%M%S%f")
                parsed = parsed.replace(tzinfo=_new_york_timezone(parsed.date()))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=_new_york_timezone(parsed.date()))
        return parsed.astimezone(UTC)
    except (ValueError, OverflowError):
        return None


def _new_york_timezone(value: date) -> timezone:
    """Return the US Eastern close-time offset under the post-2007 DST rule."""
    march_first = date(value.year, 3, 1)
    second_sunday = 8 + ((6 - march_first.weekday()) % 7)
    november_first = date(value.year, 11, 1)
    first_sunday = 1 + ((6 - november_first.weekday()) % 7)
    daylight = date(value.year, 3, second_sunday) <= value < date(
        value.year, 11, first_sunday
    )
    return timezone(timedelta(hours=-4 if daylight else -5), name="America/New_York")


@dataclass(frozen=True, slots=True)
class KGIInventoryAdapter:
    gateway: InventoryGateway
    identity: AccountIdentityProjector

    def get_health(self) -> BrokerHealth:
        return self.gateway.get_health()

    def get_positions(self) -> BrokerPositionSnapshot:
        batch = self.gateway.read_inventory("B")
        return self._normalize(batch)

    def get_positions_v2(self) -> BrokerPositionSnapshotV2:
        return self._normalize_v2(self.gateway.read_positions_v2())

    def _normalize(self, batch: RawInventoryBatch) -> BrokerPositionSnapshot:
        captured_at = _aware_utc(batch.captured_at, "captured_at")
        source_as_of = _aware_utc(batch.source_as_of, "source_as_of")
        if batch.explicit_empty and batch.rows:
            raise SchemaParseError("explicit_empty")
        try:
            account = self.identity.project(batch.account_ref)
        except ValueError as exc:
            raise SchemaParseError("account_ref") from exc
        warnings = list(batch.warnings)

        if batch.explicit_empty:
            return self._snapshot(
                account=account,
                captured_at=captured_at,
                source_as_of=source_as_of,
                status=SnapshotStatus.EXPLICIT_EMPTY,
                positions=(),
                valuations=(),
                warnings=_stable(warnings),
            )
        if not batch.rows:
            raise AmbiguousEmptyInventoryError

        positions: list[BrokerPosition] = []
        valuations: list[BrokerInstrumentValuation] = []
        position_keys: set[tuple[str, PositionType]] = set()
        valuation_symbols: set[str] = set()

        for raw in batch.rows:
            symbol = _required_text(raw.get("Symbol"), "Symbol").upper()
            name = _required_text(raw.get("SymbolName"), "SymbolName")
            if symbol in valuation_symbols:
                raise SchemaParseError("duplicate_Symbol")
            valuation_symbols.add(symbol)

            last_price = _decimal(raw.get("RLPRICE"), "RLPRICE")
            if last_price is not None and last_price <= 0:
                last_price = None
                warnings.append(f"nonpositive_last_price_treated_as_missing:{symbol}")
            broker_market_value = _decimal(raw.get("ASSET"), "ASSET")
            if broker_market_value is not None and broker_market_value < 0:
                raise SchemaParseError("ASSET")
            quantities = _normalized_tw_quantities(
                raw,
                symbol=symbol,
                last_price=last_price,
                broker_market_value=broker_market_value,
                warnings=warnings,
            )

            average_cost = _decimal(raw.get("AVG_PRICE0"), "AVG_PRICE0")
            if average_cost is not None and average_cost <= 0:
                average_cost = None
                warnings.append(f"nonpositive_average_cost_treated_as_missing:{symbol}")

            for field, position_type in POSITION_FIELDS:
                quantity = quantities[field]
                if quantity is None or quantity == 0:
                    continue
                key = (symbol, position_type)
                if key in position_keys:
                    raise SchemaParseError(f"duplicate_{field}")
                position_keys.add(key)
                try:
                    position = BrokerPosition(
                        symbol=symbol,
                        name=name,
                        position_type=position_type,
                        quantity=quantity,
                        average_cost=average_cost if position_type is PositionType.CASH else None,
                    )
                except ValidationError as exc:
                    raise SchemaParseError(_validation_field(exc, field)) from exc
                positions.append(position)

            try:
                valuation = BrokerInstrumentValuation(
                    symbol=symbol,
                    name=name,
                    last_price=last_price,
                    broker_market_value=broker_market_value,
                    broker_unrealized_pnl=_decimal(raw.get("NETPL"), "NETPL"),
                    broker_unrealized_pnl_twd=_decimal(raw.get("NETPL_TWD"), "NETPL_TWD"),
                )
            except ValidationError as exc:
                raise SchemaParseError(_validation_field(exc, "valuation")) from exc
            valuations.append(valuation)

        if not positions:
            raise AmbiguousEmptyInventoryError

        positions.sort(key=lambda item: (item.symbol, item.position_type.value))
        valuations.sort(key=lambda item: item.symbol)
        return self._snapshot(
            account=account,
            captured_at=captured_at,
            source_as_of=source_as_of,
            status=SnapshotStatus.COMPLETE,
            positions=tuple(positions),
            valuations=tuple(valuations),
            warnings=_stable(warnings),
        )

    def _normalize_v2(self, batch: RawBrokerSnapshotBatch) -> BrokerPositionSnapshotV2:
        captured_at = _aware_utc(batch.captured_at, "captured_at")
        scopes = tuple(self._normalize_scope(scope, captured_at) for scope in batch.scopes)
        if {scope.market for scope in scopes} != {"TW", "US"} or len(scopes) != 2:
            raise SchemaParseError("scopes")
        unavailable = any(
            scope.status is MarketScopeStatus.UNAVAILABLE for scope in scopes
        )
        all_empty = all(
            scope.status is MarketScopeStatus.EXPLICIT_EMPTY for scope in scopes
        )
        status = (
            AggregateSnapshotStatus.PARTIAL
            if unavailable
            else AggregateSnapshotStatus.EXPLICIT_EMPTY
            if all_empty
            else AggregateSnapshotStatus.COMPLETE
        )
        warnings = _stable(list(batch.warnings))
        hash_payload: dict[str, object] = {
            "schema_version": "broker.position.v2",
            "broker": "KGI",
            "captured_at": captured_at.isoformat(),
            "status": status.value,
            "scopes": [scope.model_dump(mode="json") for scope in scopes],
            "warnings": list(warnings),
        }
        try:
            return BrokerPositionSnapshotV2(
                captured_at=captured_at,
                status=status,
                scopes=scopes,
                warnings=warnings,
                payload_hash=_payload_hash(hash_payload),
            )
        except ValidationError as exc:
            raise SchemaParseError(_validation_field(exc, "snapshot_v2")) from exc

    def _normalize_scope(
        self, scope: RawMarketInventoryScope, captured_at: datetime
    ) -> BrokerMarketScopeV2:
        source = (
            "kgi.inventory_sum" if scope.market == "TW" else "kgi.stock_position_report"
        )
        if scope.error_code:
            try:
                return BrokerMarketScopeV2(
                    market=scope.market,
                    status=MarketScopeStatus.UNAVAILABLE,
                    source=source,
                    warnings=scope.warnings,
                    error_code=scope.error_code,
                )
            except ValidationError as exc:
                raise SchemaParseError(_validation_field(exc, f"{scope.market}.scope")) from exc
        if not scope.account_ref or scope.source_as_of is None:
            raise SchemaParseError(f"{scope.market}.account_or_as_of")
        source_as_of = _aware_utc(scope.source_as_of, f"{scope.market}.source_as_of")
        if scope.explicit_empty and scope.rows:
            raise SchemaParseError(f"{scope.market}.explicit_empty")
        try:
            account = self.identity.project(scope.account_ref)
        except ValueError as exc:
            raise SchemaParseError(f"{scope.market}.account_ref") from exc
        if scope.explicit_empty:
            return BrokerMarketScopeV2(
                market=scope.market,
                account=account,
                status=MarketScopeStatus.EXPLICIT_EMPTY,
                source=source,
                source_as_of=source_as_of,
                warnings=scope.warnings,
            )
        if not scope.rows:
            raise AmbiguousEmptyInventoryError
        if scope.market == "TW":
            return self._normalize_tw_scope(scope, captured_at, source_as_of, account)
        return self._normalize_us_scope(scope, source_as_of, account)

    def _normalize_tw_scope(
        self,
        scope: RawMarketInventoryScope,
        captured_at: datetime,
        source_as_of: datetime,
        account: BrokerAccountRef,
    ) -> BrokerMarketScopeV2:
        snapshot = self._normalize(
            RawInventoryBatch(
                account_ref=scope.account_ref or "",
                captured_at=captured_at,
                source_as_of=source_as_of,
                rows=scope.rows,
                explicit_empty=False,
                warnings=scope.warnings,
            )
        )
        positions = tuple(
            BrokerPositionV2(
                market="TW",
                symbol=item.symbol,
                name=item.name,
                currency="TWD",
                position_type=item.position_type,
                quantity=item.quantity,
                average_cost=item.average_cost,
            )
            for item in snapshot.positions
        )
        valuations = tuple(
            BrokerInstrumentValuationV2(
                market="TW",
                symbol=item.symbol,
                name=item.name,
                currency="TWD",
                last_price=item.last_price,
                native_market_value=item.broker_market_value,
                price_as_of=source_as_of if item.last_price is not None else None,
                price_quality=(
                    PriceQuality.BROKER_REPORTED
                    if item.last_price is not None
                    else PriceQuality.MISSING
                ),
                broker_unrealized_pnl_native=item.broker_unrealized_pnl,
                broker_unrealized_pnl_twd=item.broker_unrealized_pnl_twd,
            )
            for item in snapshot.valuations
        )
        return BrokerMarketScopeV2(
            market="TW",
            account=account,
            status=MarketScopeStatus.COMPLETE,
            source="kgi.inventory_sum",
            source_as_of=source_as_of,
            positions=positions,
            valuations=valuations,
            warnings=snapshot.warnings,
        )

    def _normalize_us_scope(
        self,
        scope: RawMarketInventoryScope,
        source_as_of: datetime,
        account: BrokerAccountRef,
    ) -> BrokerMarketScopeV2:
        warnings = list(scope.warnings)
        grouped: dict[str, dict[str, object]] = {}
        for raw in scope.rows:
            symbol = _required_text(raw.get("symbol"), "US.symbol").upper()
            quantity = _decimal(raw.get("Qty"), "US.Qty")
            if quantity is None or quantity == 0:
                continue
            current = grouped.get(symbol)
            if current is None:
                grouped[symbol] = {**raw, "Qty": quantity}
            else:
                current_quantity = _decimal(current.get("Qty"), "US.Qty") or Decimal(0)
                current["Qty"] = current_quantity + quantity
                warnings.append(f"duplicate_us_symbol_aggregated:{symbol}")
        if not grouped:
            raise AmbiguousEmptyInventoryError

        positions: list[BrokerPositionV2] = []
        valuations: list[BrokerInstrumentValuationV2] = []
        for symbol, raw in grouped.items():
            name = str(raw.get("symbol_name", "")).strip() or symbol
            if name == symbol:
                warnings.append(f"missing_us_name_using_symbol:{symbol}")
            currency = _required_text(raw.get("currency"), "US.currency").upper()
            if currency != "USD":
                raise SchemaParseError("US.currency")
            quantity = _decimal(raw.get("Qty"), "US.Qty")
            assert quantity is not None
            settlement_currency = str(raw.get("settle_currency", "")).strip() or None

            snapshot_price = _decimal(raw.get("_snapshot_close"), "US.snapshot_close")
            snapshot_as_of = _us_price_as_of(raw.get("_snapshot_timestamp"))
            report_price = _decimal(raw.get("market_price"), "US.market_price")
            report_as_of = _us_price_as_of(raw.get("close_date"), date_only=True)
            if snapshot_price is not None and snapshot_price > 0 and snapshot_as_of:
                last_price = snapshot_price
                price_as_of = snapshot_as_of
                quality = PriceQuality.BROKER_SNAPSHOT
            elif report_price is not None and report_price > 0 and report_as_of:
                last_price = report_price
                price_as_of = report_as_of
                quality = PriceQuality.BROKER_CLOSE
                warnings.append(f"us_report_close_used:{symbol}")
            else:
                last_price = None
                price_as_of = None
                quality = PriceQuality.MISSING
                warnings.append(f"us_price_missing:{symbol}")
            native_market_value = (
                quantity * last_price if last_price is not None and quantity > 0 else None
            )
            try:
                positions.append(
                    BrokerPositionV2(
                        market="US",
                        symbol=symbol,
                        name=name,
                        currency="USD",
                        settlement_currency=settlement_currency,
                        position_type=PositionType.CASH,
                        quantity=quantity,
                    )
                )
                valuations.append(
                    BrokerInstrumentValuationV2(
                        market="US",
                        symbol=symbol,
                        name=name,
                        currency="USD",
                        last_price=last_price,
                        native_market_value=native_market_value,
                        price_as_of=price_as_of,
                        price_quality=quality,
                    )
                )
            except ValidationError as exc:
                raise SchemaParseError(_validation_field(exc, "US")) from exc
        positions.sort(key=lambda item: item.symbol)
        valuations.sort(key=lambda item: item.symbol)
        return BrokerMarketScopeV2(
            market="US",
            account=account,
            status=MarketScopeStatus.COMPLETE,
            source="kgi.stock_position_report",
            source_as_of=source_as_of,
            positions=tuple(positions),
            valuations=tuple(valuations),
            warnings=_stable(warnings),
        )

    @staticmethod
    def _snapshot(
        *,
        account: BrokerAccountRef,
        captured_at: datetime,
        source_as_of: datetime,
        status: SnapshotStatus,
        positions: tuple[BrokerPosition, ...],
        valuations: tuple[BrokerInstrumentValuation, ...],
        warnings: tuple[str, ...],
    ) -> BrokerPositionSnapshot:
        hash_payload: dict[str, object] = {
            "schema_version": "broker.position.v1",
            "broker": "KGI",
            "account": account.model_dump(mode="json"),
            "captured_at": captured_at.isoformat(),
            "source_as_of": source_as_of.isoformat(),
            "status": status.value,
            "source": "kgi.inventory_sum",
            "positions": [item.model_dump(mode="json") for item in positions],
            "valuations": [item.model_dump(mode="json") for item in valuations],
            "warnings": list(warnings),
        }
        try:
            return BrokerPositionSnapshot(
                account=account,
                captured_at=captured_at,
                source_as_of=source_as_of,
                status=status,
                positions=positions,
                valuations=valuations,
                warnings=warnings,
                payload_hash=_payload_hash(hash_payload),
            )
        except ValidationError as exc:
            raise SchemaParseError(_validation_field(exc, "snapshot")) from exc
