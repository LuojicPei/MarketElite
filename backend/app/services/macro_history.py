from __future__ import annotations

import asyncio
from datetime import date, timedelta
from typing import Any

from app.core.config import Settings
from app.services.providers.fred import FredClient
from app.services.resilience import DualTTLCache

MACRO_HISTORY_CACHE_KEY = "marketelite:macro:release_history:v1"

# Official past/recent FOMC decision dates for sampling DFEDTARL/DFEDTARU target bounds
_FOMC_MEETING_DATES: tuple[str, ...] = (
    "2024-11-07",
    "2024-12-18",
    "2025-01-29",
    "2025-03-19",
    "2025-05-07",
    "2025-06-18",
    "2025-07-30",
    "2025-09-17",
    "2025-10-29",
    "2025-12-10",
    "2026-01-28",
    "2026-03-18",
    "2026-04-29",
    "2026-06-17",
    "2026-07-29",
    "2026-09-16",
    "2026-10-28",
    "2026-12-09",
)


def _to_ym_map(obs: list[dict[str, Any]]) -> dict[str, float]:
    out: dict[str, float] = {}
    for row in obs:
        d = str(row.get("obs_date") or "")[:7]
        v = row.get("value")
        if len(d) == 7 and isinstance(v, (int, float)):
            out[d] = float(v)
    return out


def _shift_ym(ym: str, delta_months: int) -> str:
    year, month = int(ym[:4]), int(ym[5:7])
    total = (year * 12 + (month - 1)) + delta_months
    ny, nm = divmod(total, 12)
    return f"{ny:04d}-{nm + 1:02d}"


def _format_ym_zh(ym: str) -> str:
    return f"{ym[:4]}年{int(ym[5:7])}月"


def _fmt_signed_pct(val: float, decimals: int = 2) -> str:
    sign = "+" if val >= 0 else ""
    return f"{sign}{val:.{decimals}f}%"


def _build_monthly_yoy_indicator(
    *,
    ind_id: str,
    title_zh: str,
    short_zh: str,
    subtitle_en: str,
    primary_obs: list[dict[str, Any]],
    secondary_obs: list[dict[str, Any]] | None,
    secondary_label: str | None,
    primary_is_mom: bool = False,
    limit: int = 10,
) -> dict[str, Any] | None:
    p_map = _to_ym_map(primary_obs)
    s_map = _to_ym_map(secondary_obs or [])
    yms = sorted(p_map.keys())
    points: list[dict[str, Any]] = []

    for ym in yms:
        cur = p_map[ym]
        prev_m = p_map.get(_shift_ym(ym, -1))
        prev_y = p_map.get(_shift_ym(ym, -12))
        mom = ((cur / prev_m) - 1.0) * 100.0 if (prev_m and prev_m > 0) else None
        yoy = ((cur / prev_y) - 1.0) * 100.0 if (prev_y and prev_y > 0) else None

        headline = mom if primary_is_mom else yoy
        if headline is None:
            continue

        sec_val: float | None = None
        if s_map:
            s_cur = s_map.get(ym)
            s_prev_y = s_map.get(_shift_ym(ym, -12))
            if s_cur is not None and s_prev_y and s_prev_y > 0:
                sec_val = ((s_cur / s_prev_y) - 1.0) * 100.0

        points.append(
            {
                "period": ym,
                "label_zh": _format_ym_zh(ym),
                "headline": round(headline, 2),
                "mom": round(mom, 2) if mom is not None else None,
                "yoy": round(yoy, 2) if yoy is not None else None,
                "sec": round(sec_val, 2) if sec_val is not None else None,
            }
        )

    if not points:
        return None

    records: list[dict[str, Any]] = []
    for idx in range(len(points) - 1, max(-1, len(points) - 1 - limit), -1):
        pt = points[idx]
        prev_pt = points[idx - 1] if idx >= 1 else None
        diff = round(pt["headline"] - prev_pt["headline"], 2) if prev_pt else None
        trend = (
            "up" if (diff is not None and diff > 0.03)
            else "down" if (diff is not None and diff < -0.03)
            else "flat"
        )
        sec_disp = _fmt_signed_pct(pt["sec"], 2) if pt["sec"] is not None else None
        mom_disp = (
            f"同比 {_fmt_signed_pct(pt['yoy'], 2)}"
            if primary_is_mom and pt["yoy"] is not None
            else f"环比 {_fmt_signed_pct(pt['mom'], 2)}"
            if pt["mom"] is not None
            else None
        )
        records.append(
            {
                "period": pt["period"],
                "label_zh": pt["label_zh"],
                "actual_value": pt["headline"],
                "actual_display": _fmt_signed_pct(pt["headline"], 2),
                "previous_display": _fmt_signed_pct(prev_pt["headline"], 2) if prev_pt else None,
                "secondary_label": secondary_label if sec_disp else None,
                "secondary_display": sec_disp,
                "mom_display": mom_disp,
                "delta_display": (
                    f"{'+' if diff >= 0 else ''}{diff:.2f}pct" if diff is not None else None
                ),
                "trend": trend,
            }
        )

    latest = records[0]
    summary_parts = [f"最近({latest['label_zh']}): {latest['actual_display']}"]
    if latest["secondary_label"] and latest["secondary_display"]:
        summary_parts.append(f"{latest['secondary_label']} {latest['secondary_display']}")
    if latest["previous_display"]:
        summary_parts.append(f"前值 {latest['previous_display']}")

    return {
        "id": ind_id,
        "title_zh": title_zh,
        "short_zh": short_zh,
        "subtitle_en": subtitle_en,
        "source_tag": "FRED 官方实绩",
        "unit_zh": "%",
        "latest_period_zh": latest["label_zh"],
        "latest_display": latest["actual_display"],
        "previous_display": latest["previous_display"],
        "secondary_badge": (
            f"{latest['secondary_label']} {latest['secondary_display']}"
            if latest["secondary_label"] and latest["secondary_display"]
            else latest["mom_display"]
        ),
        "delta_display": latest["delta_display"],
        "trend": latest["trend"],
        "summary_line_zh": " · ".join(summary_parts),
        "records": records,
    }


def _build_nfp_indicator(
    payems_obs: list[dict[str, Any]],
    unrate_obs: list[dict[str, Any]],
    limit: int = 10,
) -> dict[str, Any] | None:
    p_map = _to_ym_map(payems_obs)
    u_map = _to_ym_map(unrate_obs)
    yms = sorted(p_map.keys())
    points: list[dict[str, Any]] = []
    for ym in yms:
        prev_val = p_map.get(_shift_ym(ym, -1))
        if prev_val is None:
            continue
        delta_k = round(p_map[ym] - prev_val, 1)
        unemp = u_map.get(ym)
        points.append(
            {
                "period": ym,
                "label_zh": _format_ym_zh(ym),
                "delta_k": delta_k,
                "unrate": round(unemp, 1) if unemp is not None else None,
            }
        )
    if not points:
        return None

    def _fmt_k_wan(val_k: float) -> str:
        sign = "+" if val_k >= 0 else "-"
        return f"{sign}{abs(val_k) / 10.0:.1f}万"

    records: list[dict[str, Any]] = []
    for idx in range(len(points) - 1, max(-1, len(points) - 1 - limit), -1):
        pt = points[idx]
        prev_pt = points[idx - 1] if idx >= 1 else None
        diff_k = round(pt["delta_k"] - prev_pt["delta_k"], 1) if prev_pt else None
        trend = (
            "up" if (diff_k is not None and diff_k > 5.0)
            else "down" if (diff_k is not None and diff_k < -5.0)
            else "flat"
        )
        records.append(
            {
                "period": pt["period"],
                "label_zh": pt["label_zh"],
                "actual_value": pt["delta_k"],
                "actual_display": _fmt_k_wan(pt["delta_k"]),
                "previous_display": _fmt_k_wan(prev_pt["delta_k"]) if prev_pt else None,
                "secondary_label": "失业率" if pt["unrate"] is not None else None,
                "secondary_display": f"{pt['unrate']:.1f}%" if pt["unrate"] is not None else None,
                "mom_display": f"{pt['delta_k']:+.0f}K 千人",
                "delta_display": _fmt_k_wan(diff_k) if diff_k is not None else None,
                "trend": trend,
            }
        )

    latest = records[0]
    un_str = f" · 失业率 {latest['secondary_display']}" if latest["secondary_display"] else ""
    prev_str = f" · 前值 {latest['previous_display']}" if latest["previous_display"] else ""
    return {
        "id": "nfp",
        "title_zh": "非农就业 NFP",
        "short_zh": "非农NFP",
        "subtitle_en": "Nonfarm Payrolls (PAYEMS / UNRATE)",
        "source_tag": "FRED 官方实绩",
        "unit_zh": "万人",
        "latest_period_zh": latest["label_zh"],
        "latest_display": latest["actual_display"],
        "previous_display": latest["previous_display"],
        "secondary_badge": f"失业率 {latest['secondary_display']}" if latest["secondary_display"] else None,
        "delta_display": latest["delta_display"],
        "trend": latest["trend"],
        "summary_line_zh": f"最近({latest['label_zh']}): {latest['actual_display']}{un_str}{prev_str}",
        "records": records,
    }


def _build_fomc_indicator(
    upper_obs: list[dict[str, Any]],
    lower_obs: list[dict[str, Any]],
    limit: int = 10,
) -> dict[str, Any] | None:
    if not upper_obs or not lower_obs:
        return None
    u_sorted = sorted((str(r["obs_date"])[:10], float(r["value"])) for r in upper_obs if r.get("obs_date"))
    l_map = {str(r["obs_date"])[:10]: float(r["value"]) for r in lower_obs if r.get("obs_date")}
    today_str = date.today().isoformat()

    def _band_at_date(target_d: str) -> tuple[float, float] | None:
        cutoff = (date.fromisoformat(target_d) + timedelta(days=2)).isoformat()
        chosen: tuple[str, float] | None = None
        for d_str, u_val in u_sorted:
            if d_str <= cutoff and d_str in l_map:
                chosen = (d_str, u_val)
            elif d_str > cutoff:
                break
        if chosen is None:
            return None
        return (l_map[chosen[0]], chosen[1])

    meetings: list[tuple[str, float, float]] = []
    for m_date in _FOMC_MEETING_DATES:
        if m_date > today_str:
            continue
        band = _band_at_date(m_date)
        if band is not None:
            meetings.append((m_date, band[0], band[1]))

    if not meetings:
        return None

    records: list[dict[str, Any]] = []
    for idx in range(len(meetings) - 1, max(-1, len(meetings) - 1 - limit), -1):
        m_date, lo, hi = meetings[idx]
        prev_hi = meetings[idx - 1][2] if idx >= 1 else None
        prev_band = f"{meetings[idx - 1][1]:.2f}%-{prev_hi:.2f}%" if idx >= 1 else None
        diff_bp = round((hi - prev_hi) * 100) if prev_hi is not None else None
        if diff_bp is None or diff_bp == 0:
            action = "维持不变"
            delta_s = "0bp"
            trend = "flat"
        elif diff_bp < 0:
            action = f"降息 {abs(diff_bp)}bp"
            delta_s = f"{diff_bp}bp"
            trend = "down"
        else:
            action = f"加息 +{diff_bp}bp"
            delta_s = f"+{diff_bp}bp"
            trend = "up"

        records.append(
            {
                "period": m_date,
                "label_zh": f"{m_date[:4]}年{int(m_date[5:7])}月{int(m_date[8:10])}日",
                "actual_value": hi,
                "actual_display": f"{lo:.2f}%-{hi:.2f}%",
                "previous_display": prev_band,
                "secondary_label": "决议",
                "secondary_display": action,
                "mom_display": None,
                "delta_display": delta_s,
                "trend": trend,
            }
        )

    latest = records[0]
    return {
        "id": "fomc",
        "title_zh": "FOMC 联邦目标利率",
        "short_zh": "FOMC利率",
        "subtitle_en": "Fed Funds Target Range (DFEDTARL/U)",
        "source_tag": "FRED 官方实绩",
        "unit_zh": "%",
        "latest_period_zh": latest["label_zh"],
        "latest_display": latest["actual_display"],
        "previous_display": latest["previous_display"],
        "secondary_badge": latest["secondary_display"],
        "delta_display": latest["delta_display"],
        "trend": latest["trend"],
        "summary_line_zh": f"现行({latest['label_zh']}): {latest['actual_display']} ({latest['secondary_display']})",
        "records": records,
    }


def _build_gdp_indicator(gdp_obs: list[dict[str, Any]], limit: int = 8) -> dict[str, Any] | None:
    valid = [
        (str(r["obs_date"])[:10], float(r["value"]))
        for r in gdp_obs
        if r.get("obs_date") and isinstance(r.get("value"), (int, float))
    ]
    if not valid:
        return None
    valid.sort(key=lambda x: x[0])

    def _q_label(d_str: str) -> str:
        m = int(d_str[5:7])
        q = ((m - 1) // 3) + 1
        return f"{d_str[:4]}年Q{q}"

    records: list[dict[str, Any]] = []
    for idx in range(len(valid) - 1, max(-1, len(valid) - 1 - limit), -1):
        d_str, val = valid[idx]
        prev_val = valid[idx - 1][1] if idx >= 1 else None
        diff = round(val - prev_val, 2) if prev_val is not None else None
        trend = (
            "up" if (diff is not None and diff > 0.1)
            else "down" if (diff is not None and diff < -0.1)
            else "flat"
        )
        records.append(
            {
                "period": d_str[:7],
                "label_zh": _q_label(d_str),
                "actual_value": round(val, 2),
                "actual_display": _fmt_signed_pct(val, 1),
                "previous_display": _fmt_signed_pct(prev_val, 1) if prev_val is not None else None,
                "secondary_label": "口径",
                "secondary_display": "季调年化",
                "mom_display": None,
                "delta_display": f"{diff:+.1f}pct" if diff is not None else None,
                "trend": trend,
            }
        )

    latest = records[0]
    prev_part = f" · 前值 {latest['previous_display']}" if latest["previous_display"] else ""
    return {
        "id": "gdp",
        "title_zh": "美国实际 GDP 增速",
        "short_zh": "美国GDP",
        "subtitle_en": "Real GDP QoQ SAAR (A191RL1Q225SBEA)",
        "source_tag": "FRED 官方实绩",
        "unit_zh": "%",
        "latest_period_zh": latest["label_zh"],
        "latest_display": latest["actual_display"],
        "previous_display": latest["previous_display"],
        "secondary_badge": "季调环比年率",
        "delta_display": latest["delta_display"],
        "trend": latest["trend"],
        "summary_line_zh": f"最近({latest['label_zh']}): {latest['actual_display']}{prev_part}",
        "records": records,
    }


async def build_macro_release_history(
    cache: DualTTLCache,
    settings: Settings,
    *,
    force_refresh: bool = False,
) -> list[dict[str, Any]]:
    """Fetch official FRED macro release actuals and compute historical trajectories."""

    async def _assemble() -> list[dict[str, Any]]:
        fred = FredClient(settings, cache=cache)
        series_ids = (
            "DFEDTARU",
            "DFEDTARL",
            "PAYEMS",
            "UNRATE",
            "CPIAUCSL",
            "CPILFESL",
            "PCEPI",
            "PCEPILFE",
            "PPIFIS",
            "A191RL1Q225SBEA",
            "RSAFS",
        )
        raw_results = await asyncio.gather(
            *(fred.get_series(sid, lookback_days=820, force_refresh=force_refresh) for sid in series_ids),
            return_exceptions=True,
        )
        obs_map: dict[str, list[dict[str, Any]]] = {}
        for sid, res in zip(series_ids, raw_results, strict=False):
            if isinstance(res, dict) and isinstance(res.get("observations"), list):
                obs_map[sid] = res["observations"]
            else:
                obs_map[sid] = []

        candidates = [
            _build_fomc_indicator(obs_map["DFEDTARU"], obs_map["DFEDTARL"]),
            _build_nfp_indicator(obs_map["PAYEMS"], obs_map["UNRATE"]),
            _build_monthly_yoy_indicator(
                ind_id="cpi",
                title_zh="消费者物价指数 CPI",
                short_zh="美国CPI",
                subtitle_en="Headline & Core CPI YoY (CPIAUCSL / CPILFESL)",
                primary_obs=obs_map["CPIAUCSL"],
                secondary_obs=obs_map["CPILFESL"],
                secondary_label="核心CPI",
            ),
            _build_monthly_yoy_indicator(
                ind_id="pce",
                title_zh="核心 PCE 物价指数",
                short_zh="核心PCE",
                subtitle_en="Core & Headline PCE YoY (PCEPILFE / PCEPI)",
                primary_obs=obs_map["PCEPILFE"],
                secondary_obs=obs_map["PCEPI"],
                secondary_label="整体PCE",
            ),
            _build_monthly_yoy_indicator(
                ind_id="ppi",
                title_zh="生产者物价指数 PPI",
                short_zh="美国PPI",
                subtitle_en="Final Demand PPI YoY/MoM (PPIFIS)",
                primary_obs=obs_map["PPIFIS"],
                secondary_obs=None,
                secondary_label=None,
            ),
            _build_gdp_indicator(obs_map["A191RL1Q225SBEA"]),
            _build_monthly_yoy_indicator(
                ind_id="retail",
                title_zh="美国零售销售月率",
                short_zh="零售销售",
                subtitle_en="Advance Retail Sales MoM (RSAFS)",
                primary_obs=obs_map["RSAFS"],
                secondary_obs=None,
                secondary_label=None,
                primary_is_mom=True,
            ),
        ]
        return [item for item in candidates if item is not None]

    res = await cache.get_or_fetch(
        MACRO_HISTORY_CACHE_KEY,
        provider="fred_macro_history",
        fetcher=_assemble,
        soft_ttl_seconds=3600,
        hard_ttl_seconds=86400 * 7,
        force_refresh=force_refresh,
    )
    return res.data if isinstance(res.data, list) else []


def _match_indicator_id_for_event(title: str) -> str | None:
    low = title.lower()
    if "fomc" in low and "minute" not in low and "纪要" not in low:
        return "fomc"
    if "nfp" in low or "employment" in low or "非农" in low:
        return "nfp"
    if "cpi" in low:
        return "cpi"
    if "pce" in low:
        return "pce"
    if "ppi" in low:
        return "ppi"
    if "gdp" in low:
        return "gdp"
    if "retail" in low or "零售" in low:
        return "retail"
    return None


def attach_macro_context_to_events(
    events: list[dict[str, Any]],
    history: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Enrich upcoming macro event dicts with latest official FRED prior/reference print."""
    if not events or not history:
        return events
    by_id = {str(h.get("id")): h for h in history if isinstance(h, dict)}
    enriched: list[dict[str, Any]] = []
    for ev in events:
        copy_ev = dict(ev)
        if copy_ev.get("event_type") == "macro" and not copy_ev.get("previous_summary"):
            ind_id = _match_indicator_id_for_event(str(copy_ev.get("title") or ""))
            ind = by_id.get(ind_id) if ind_id else None
            if ind:
                copy_ev["previous_summary"] = ind.get("summary_line_zh")
                copy_ev["indicator_id"] = ind_id
                if copy_ev.get("previous") is None and ind.get("records"):
                    first_rec = ind["records"][0]
                    val = first_rec.get("actual_value")
                    if isinstance(val, (int, float)):
                        copy_ev["previous"] = float(val)
        enriched.append(copy_ev)
    return enriched
