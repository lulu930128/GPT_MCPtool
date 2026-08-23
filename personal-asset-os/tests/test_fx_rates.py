from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import httpx

from personal_asset_os.services.fx_rates import (
    OfficialUsdTwdRateProvider,
    parse_bot_usd_twd,
    parse_cbc_usd_twd,
    parse_taifex_usd_twd,
)
from personal_asset_os.settings import Settings

NOW = datetime(2026, 8, 20, 10, 0, tzinfo=UTC)


def cbc_payload(date: str, rate: str) -> dict[str, object]:
    return {
        "meta": {"last_updated": date},
        "data": {
            "structure": {
                "Table1": [
                    {"data": "新台幣NTD/USD"},
                    {"data": "日圓JPY/USD"},
                ]
            },
            "dataSets": [[date.replace("-", ""), rate, "150.0"]],
        },
    }


def settings(**values: object) -> Settings:
    return Settings(_env_file=None, **values)


def test_cbc_parser_uses_ntd_per_usd_and_taipei_close_time() -> None:
    fact = parse_cbc_usd_twd(cbc_payload("2026-08-20", "31.875"), retrieved_at=NOW)

    assert fact.rate == Decimal("31.875")
    assert fact.provider == "cbc.bp01d01"
    assert fact.quality == "official_close"
    assert fact.effective_at == datetime(2026, 8, 20, 8, 0, tzinfo=UTC)


def test_taifex_parser_selects_latest_daily_usd_ntd_reference() -> None:
    fact = parse_taifex_usd_twd(
        [
            {"Date": "20260818", "USD/NTD": "31.900"},
            {"Date": "20260819", "USD/NTD": "31.937"},
        ],
        retrieved_at=NOW,
    )

    assert fact.rate == Decimal("31.937")
    assert fact.provider == "taifex.daily_fx"
    assert fact.quality == "official_reference"
    assert fact.effective_precision == "date"


def test_bot_parser_uses_usd_spot_buy_sell_midpoint() -> None:
    fact = parse_bot_usd_twd(
        "USD Buying 31.50000 31.85000 0 0 Selling 32.50000 32.00000 0 0\n",
        retrieved_at=NOW,
    )

    assert fact.rate == Decimal("31.925")
    assert fact.spot_buy == Decimal("31.85000")
    assert fact.spot_sell == Decimal("32.00000")
    assert fact.provider == "bot.spot_mid"


def test_stale_exchange_sources_fall_back_to_bot_and_cache_is_memory_only() -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.host)
        if request.url.host == "openapi.taifex.com.tw":
            return httpx.Response(200, json=[])
        if request.url.host == "cpx.cbc.gov.tw":
            return httpx.Response(200, json=cbc_payload("2026-07-31", "32.292"))
        return httpx.Response(
            200,
            text="USD Buying 31.50000 31.85000 0 0 Selling 32.50000 32.00000 0 0\n",
        )

    provider = OfficialUsdTwdRateProvider(
        settings(fx_cache_ttl_seconds=900), transport=httpx.MockTransport(handler)
    )
    first = provider.read(now=NOW)
    second = provider.read(now=NOW)

    assert first.status == "complete"
    assert first.fact is not None and first.fact.provider == "bot.spot_mid"
    assert any("超過允許時效" in warning for warning in first.warnings)
    assert second.read_mode == "memory_cache"
    assert requests == [
        "openapi.taifex.com.tw",
        "cpx.cbc.gov.tw",
        "rate.bot.com.tw",
    ]


def test_fresh_taifex_rate_is_primary_and_skips_fallbacks() -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.url.host)
        return httpx.Response(200, json=[{"Date": "20260819", "USD/NTD": "31.937"}])

    result = OfficialUsdTwdRateProvider(
        settings(), transport=httpx.MockTransport(handler)
    ).read(now=NOW)

    assert result.fact is not None and result.fact.provider == "taifex.daily_fx"
    assert result.fact.rate == Decimal("31.937")
    assert requests == ["openapi.taifex.com.tw"]


def test_unusable_official_sources_do_not_publish_an_fx_rate() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "openapi.taifex.com.tw":
            return httpx.Response(200, json=[])
        if request.url.host == "cpx.cbc.gov.tw":
            return httpx.Response(200, json={"unexpected": True})
        return httpx.Response(200, text="<!doctype html><title>Challenge Validation</title>")

    result = OfficialUsdTwdRateProvider(
        settings(), transport=httpx.MockTransport(handler)
    ).read(now=NOW)

    assert result.status == "unavailable"
    assert result.fact is None
    assert "未換算為 TWD" in result.warnings[0]
