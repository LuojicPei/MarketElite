from __future__ import annotations

import csv
import io
import re
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import ImportedHolding, MarketDailyBar

_SYMBOL_ALIASES = {"symbol", "ticker", "instrument", "code", "代码", "股票代码", "标的"}
_QTY_ALIASES = {"qty", "quantity", "shares", "position", "units", "股数", "持仓股数", "数量"}
_COST_ALIASES = {
    "avg_cost",
    "average_cost",
    "avg_price",
    "average_price",
    "cost_basis",
    "cost",
    "price",
    "entry_price",
    "成本价",
    "均价",
    "成本",
}
_SIDE_ALIASES = {"side", "direction", "方向"}
_CCY_ALIASES = {"currency", "ccy", "币种"}

_QUICK_LINE_RE = re.compile(
    r"^\s*([A-Za-z0-9.\-]{1,16})\s*(?:[,|\s]+|@)\s*([0-9]+(?:\.[0-9]+)?)(?:\s*(?:,|@|\s)\s*\$?([0-9]+(?:\.[0-9]+)?))?\s*$"
)


def _clean_num(raw: Any) -> float | None:
    if raw is None:
        return None
    s = str(raw).strip().replace("$", "").replace("£", "").replace("€", "").replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_holdings_input(
    raw_text: str,
    *,
    default_source: str = "CSV / 自定义导入",
) -> list[dict[str, Any]]:
    """Parse flexible CSV exports (Robinhood / Webull / Schwab / Futu / custom) or quick text lines."""
    text = (raw_text or "").strip()
    if not text:
        return []

    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return []

    first_cells = [c.strip().lower().replace(" ", "_") for c in next(csv.reader([lines[0]]))]
    has_header = any(c in _SYMBOL_ALIASES for c in first_cells) and len(lines) >= 2

    parsed: list[dict[str, Any]] = []
    if has_header:
        reader = csv.DictReader(io.StringIO("\n".join(lines)))
        for row in reader:
            norm_row = {
                str(k or "").strip().lower().replace(" ", "_"): (v or "").strip()
                for k, v in row.items()
            }
            sym = next((norm_row[k] for k in _SYMBOL_ALIASES if norm_row.get(k)), "")
            sym = sym.upper().replace("$", "").strip()
            if not sym or sym in ("TOTAL", "CASH", "USD", "GBP", "EUR"):
                continue
            qty_raw = next((norm_row[k] for k in _QTY_ALIASES if norm_row.get(k)), None)
            qty = _clean_num(qty_raw)
            if qty is None or abs(qty) <= 0:
                continue
            cost_raw = next((norm_row[k] for k in _COST_ALIASES if norm_row.get(k)), None)
            cost = _clean_num(cost_raw)
            side_raw = next((norm_row[k] for k in _SIDE_ALIASES if norm_row.get(k)), "long").lower()
            side = "short" if (qty < 0 or side_raw in ("sell", "short", "空")) else "long"
            ccy_raw = next((norm_row[k] for k in _CCY_ALIASES if norm_row.get(k)), "USD").upper()
            parsed.append(
                {
                    "symbol": sym[:24],
                    "side": side,
                    "qty": round(abs(qty), 6),
                    "avg_cost_price": round(abs(cost), 4) if cost and cost > 0 else None,
                    "currency": ccy_raw[:8] or "USD",
                    "source_label": default_source,
                }
            )
    else:
        for ln in lines:
            m = _QUICK_LINE_RE.match(ln)
            if not m:
                parts = [p.strip() for p in ln.split(",") if p.strip()]
                if len(parts) >= 2:
                    sym = parts[0].upper()
                    qty = _clean_num(parts[1])
                    cost = _clean_num(parts[2]) if len(parts) >= 3 else None
                else:
                    continue
            else:
                sym = m.group(1).upper()
                qty = _clean_num(m.group(2))
                cost = _clean_num(m.group(3))
            if not sym or qty is None or abs(qty) <= 0:
                continue
            parsed.append(
                {
                    "symbol": sym[:24],
                    "side": "short" if qty < 0 else "long",
                    "qty": round(abs(qty), 6),
                    "avg_cost_price": round(abs(cost), 4) if cost and cost > 0 else None,
                    "currency": "USD",
                    "source_label": default_source,
                }
            )

    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for item in parsed:
        key = (item["symbol"], item["side"])
        if key not in merged:
            merged[key] = dict(item)
            continue
        cur = merged[key]
        prev_q = float(cur["qty"])
        add_q = float(item["qty"])
        tot_q = prev_q + add_q
        prev_c = cur.get("avg_cost_price")
        add_c = item.get("avg_cost_price")
        if prev_c and add_c and tot_q > 0:
            cur["avg_cost_price"] = round((prev_q * prev_c + add_q * add_c) / tot_q, 4)
        elif add_c and not prev_c:
            cur["avg_cost_price"] = add_c
        cur["qty"] = round(tot_q, 6)
    return list(merged.values())


async def build_imported_portfolio_state(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    workspace_id: str = "default",
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Compute live mark-to-market ledger state for CSV / manually imported holdings."""
    async with session_factory() as session:
        rows = list(
            (
                await session.execute(
                    select(ImportedHolding)
                    .where(ImportedHolding.workspace_id == workspace_id)
                    .order_by(desc(ImportedHolding.updated_at))
                )
            )
            .scalars()
            .all()
        )
        close_prices: dict[str, float] = {}
        for r in rows:
            sym = r.symbol.upper().strip()
            if sym in close_prices:
                continue
            bar = (
                await session.execute(
                    select(MarketDailyBar)
                    .where(MarketDailyBar.symbol == sym)
                    .order_by(desc(MarketDailyBar.trade_date))
                    .limit(1)
                )
            ).scalar_one_or_none()
            if bar is not None and float(bar.close) > 0:
                close_prices[sym] = float(bar.close)

    positions: list[dict[str, Any]] = []
    invested_sum = 0.0
    upl_sum = 0.0
    source_name = rows[0].source_label if rows else "通用导入账本"
    for r in rows:
        sym = r.symbol.upper().strip()
        qty = float(r.qty)
        cur_px = close_prices.get(sym) or float(r.avg_cost_price or 0.0)
        entry_px = float(r.avg_cost_price or cur_px)
        mv = qty * cur_px
        cost = qty * entry_px
        mult = -1.0 if r.side == "short" else 1.0
        upl = (cur_px - entry_px) * qty * mult
        upl_pct = (upl / cost) if cost > 0 else 0.0
        invested_sum += mv
        upl_sum += upl
        positions.append(
            {
                "id": r.id,
                "symbol": sym,
                "raw_ticker": r.source_label,
                "qty": round(qty, 6),
                "side": r.side,
                "avg_entry_price": round(entry_px, 4),
                "current_price": round(cur_px, 4),
                "market_value": round(mv, 2),
                "unrealized_pl": round(upl, 2),
                "unrealized_plpc": round(upl_pct, 6),
                "currency": r.currency or "USD",
                "read_only": True,
                "imported_id": r.id,
            }
        )

    equity = round(invested_sum, 2)
    account = {
        "id": f"imported-{workspace_id}",
        "status": "ACTIVE",
        "currency": "USD",
        "equity": equity,
        "cash": 0.0,
        "buying_power": 0.0,
        "portfolio_value": equity,
        "invested_value": equity,
        "unrealized_pl": round(upl_sum, 2),
        "broker": "csv_import",
        "source_label": source_name,
        "read_only": True,
    }
    return account, positions, []
