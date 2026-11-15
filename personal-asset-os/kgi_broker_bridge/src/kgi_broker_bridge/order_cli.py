"""One-shot offline CLI. There is intentionally no live/simulation/send mode."""
from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from decimal import Decimal, InvalidOperation

from pydantic import ValidationError

from kgi_broker_bridge.order_preview import FixedOrder, OfflineSettings, preview


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline fixed KGI order preview; never sends")
    parser.add_argument("--dry-run", action="store_true", help="preview (also the default)")
    parser.add_argument("--symbol", default="2330")
    parser.add_argument("--action", default="BUY")
    parser.add_argument("--price", default="2160")
    parser.add_argument("--quantity-shares", default="1")
    # Do not echo unknown arguments: they could contain credentials supplied by mistake.
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        print(json.dumps({"state": "NOT_SENT", "error": "unsupported_arguments"}))
        return 2
    try:
        order = FixedOrder(symbol=args.symbol, action=args.action, price=Decimal(args.price),
                           quantity_shares=int(args.quantity_shares))
        result = preview(OfflineSettings(), order)
    except (ValidationError, ValueError, InvalidOperation):
        print(json.dumps({"state": "NOT_SENT", "error": "outside_fixed_test_scope"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
