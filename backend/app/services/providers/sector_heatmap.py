from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings
from app.services.providers.alpaca import AlpacaClient
from app.services.resilience import DualTTLCache, ProviderError


@dataclass(frozen=True)
class SectorConstituentSpec:
    symbol: str
    name_zh: str
    weight_in_sector_pct: float


@dataclass(frozen=True)
class SectorHeatmapSpec:
    symbol: str
    name_zh: str
    short_zh: str
    market_weight_pct: float
    constituents: tuple[SectorConstituentSpec, ...]


SECTOR_HEATMAP_CATALOG: tuple[SectorHeatmapSpec, ...] = (
    SectorHeatmapSpec(
        symbol="XLK",
        name_zh="信息技术 / 科技",
        short_zh="科技",
        market_weight_pct=31.5,
        constituents=(
            SectorConstituentSpec("NVDA", "英伟达", 16.5),
            SectorConstituentSpec("AAPL", "苹果", 14.8),
            SectorConstituentSpec("MSFT", "微软", 13.9),
            SectorConstituentSpec("AVGO", "博通", 5.8),
            SectorConstituentSpec("ORCL", "甲骨文", 2.9),
            SectorConstituentSpec("CRM", "赛富时", 2.2),
            SectorConstituentSpec("AMD", "超威半导体", 2.1),
            SectorConstituentSpec("CSCO", "思科", 1.9),
            SectorConstituentSpec("ACN", "埃森哲", 1.8),
            SectorConstituentSpec("ADBE", "Adobe", 1.7),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLF",
        name_zh="金融银行与支付",
        short_zh="金融",
        market_weight_pct=13.5,
        constituents=(
            SectorConstituentSpec("BRK.B", "伯克希尔", 13.2),
            SectorConstituentSpec("JPM", "摩根大通", 10.6),
            SectorConstituentSpec("V", "Visa", 8.1),
            SectorConstituentSpec("MA", "万事达", 6.4),
            SectorConstituentSpec("BAC", "美国银行", 4.6),
            SectorConstituentSpec("GS", "高盛", 3.1),
            SectorConstituentSpec("MS", "摩根士丹利", 2.8),
            SectorConstituentSpec("WFC", "富国银行", 2.7),
            SectorConstituentSpec("AXP", "美国运通", 2.4),
            SectorConstituentSpec("C", "花旗集团", 2.1),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLV",
        name_zh="医疗健康与创新药",
        short_zh="医疗",
        market_weight_pct=11.0,
        constituents=(
            SectorConstituentSpec("LLY", "礼来", 12.1),
            SectorConstituentSpec("UNH", "联合健康", 9.6),
            SectorConstituentSpec("JNJ", "强生", 7.4),
            SectorConstituentSpec("ABBV", "艾伯维", 6.3),
            SectorConstituentSpec("MRK", "默沙东", 5.2),
            SectorConstituentSpec("TMO", "赛默飞", 4.1),
            SectorConstituentSpec("ABT", "雅培", 3.9),
            SectorConstituentSpec("ISRG", "直觉外科", 3.5),
            SectorConstituentSpec("AMGN", "安进", 3.3),
            SectorConstituentSpec("DHR", "丹纳赫", 3.1),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLY",
        name_zh="可选消费与零售",
        short_zh="可选消费",
        market_weight_pct=10.6,
        constituents=(
            SectorConstituentSpec("AMZN", "亚马逊", 23.4),
            SectorConstituentSpec("TSLA", "特斯拉", 15.8),
            SectorConstituentSpec("HD", "家得宝", 7.3),
            SectorConstituentSpec("MCD", "麦当劳", 4.3),
            SectorConstituentSpec("LOW", "劳氏", 3.1),
            SectorConstituentSpec("BKNG", "Booking", 2.9),
            SectorConstituentSpec("TJX", "TJX百货", 2.6),
            SectorConstituentSpec("SBUX", "星巴克", 2.2),
            SectorConstituentSpec("NKE", "耐克", 1.9),
            SectorConstituentSpec("CMG", "墨式烧烤", 1.7),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLC",
        name_zh="通信服务与数字传媒",
        short_zh="通信",
        market_weight_pct=9.2,
        constituents=(
            SectorConstituentSpec("META", "Meta", 22.8),
            SectorConstituentSpec("GOOGL", "谷歌", 20.4),
            SectorConstituentSpec("NFLX", "奈飞", 5.9),
            SectorConstituentSpec("TMUS", "T-Mobile", 4.8),
            SectorConstituentSpec("DIS", "迪士尼", 4.1),
            SectorConstituentSpec("VZ", "威瑞森", 3.8),
            SectorConstituentSpec("T", "AT&T", 3.5),
            SectorConstituentSpec("CMCSA", "康卡斯特", 3.3),
            SectorConstituentSpec("EA", "艺电", 1.9),
            SectorConstituentSpec("TTWO", "Take-Two", 1.6),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLI",
        name_zh="高端工业与军工",
        short_zh="工业",
        market_weight_pct=8.4,
        constituents=(
            SectorConstituentSpec("GE", "GE航天", 5.2),
            SectorConstituentSpec("CAT", "卡特彼勒", 4.6),
            SectorConstituentSpec("RTX", "雷神科技", 4.1),
            SectorConstituentSpec("UNP", "联合太平洋", 3.7),
            SectorConstituentSpec("HON", "霍尼韦尔", 3.5),
            SectorConstituentSpec("ETN", "伊顿", 3.4),
            SectorConstituentSpec("LMT", "洛克希德", 3.1),
            SectorConstituentSpec("BA", "波音", 2.9),
            SectorConstituentSpec("DE", "迪尔农机", 2.8),
            SectorConstituentSpec("UPS", "UPS快递", 2.6),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLP",
        name_zh="必需消费与必选品",
        short_zh="必需消费",
        market_weight_pct=5.8,
        constituents=(
            SectorConstituentSpec("WMT", "沃尔玛", 11.4),
            SectorConstituentSpec("COST", "好市多", 10.8),
            SectorConstituentSpec("PG", "宝洁", 10.2),
            SectorConstituentSpec("KO", "可口可乐", 7.5),
            SectorConstituentSpec("PEP", "百事可乐", 6.4),
            SectorConstituentSpec("PM", "菲利普莫里斯", 5.6),
            SectorConstituentSpec("MDLZ", "亿滋国际", 3.4),
            SectorConstituentSpec("CL", "高露洁", 3.1),
            SectorConstituentSpec("MO", "奥驰亚", 2.9),
            SectorConstituentSpec("TGT", "塔吉特", 2.7),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLE",
        name_zh="传统能源与油气",
        short_zh="能源",
        market_weight_pct=3.5,
        constituents=(
            SectorConstituentSpec("XOM", "埃克森美孚", 23.1),
            SectorConstituentSpec("CVX", "雪佛龙", 16.4),
            SectorConstituentSpec("COP", "康菲石油", 7.8),
            SectorConstituentSpec("EOG", "EOG能源", 4.9),
            SectorConstituentSpec("SLB", "斯伦贝谢", 4.3),
            SectorConstituentSpec("MPC", "马拉松原油", 4.0),
            SectorConstituentSpec("WMB", "威廉姆斯", 3.8),
            SectorConstituentSpec("PSX", "菲利普斯66", 3.5),
            SectorConstituentSpec("VLO", "瓦莱罗能源", 3.2),
            SectorConstituentSpec("OXY", "西方石油", 3.0),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLU",
        name_zh="公用事业与电力",
        short_zh="公用事业",
        market_weight_pct=2.4,
        constituents=(
            SectorConstituentSpec("NEE", "新纪元能源", 13.8),
            SectorConstituentSpec("SO", "南方电力", 8.2),
            SectorConstituentSpec("DUK", "杜克能源", 7.6),
            SectorConstituentSpec("CEG", "星座核电", 6.9),
            SectorConstituentSpec("SRE", "桑普拉能源", 4.8),
            SectorConstituentSpec("AEP", "美国电力", 4.6),
            SectorConstituentSpec("VST", "Vistra电力", 4.3),
            SectorConstituentSpec("D", "道明尼能源", 3.9),
            SectorConstituentSpec("EXC", "爱克斯龙", 3.6),
            SectorConstituentSpec("XEL", "埃克西尔", 3.4),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLRE",
        name_zh="商业与数据中心地产",
        short_zh="房地产",
        market_weight_pct=2.2,
        constituents=(
            SectorConstituentSpec("PLD", "普洛斯物流", 11.2),
            SectorConstituentSpec("AMT", "美国电塔", 9.4),
            SectorConstituentSpec("EQIX", "Equinix算力", 8.5),
            SectorConstituentSpec("WELL", "Welltower", 7.4),
            SectorConstituentSpec("SPG", "西蒙地产", 5.8),
            SectorConstituentSpec("PSA", "Public Stor", 5.3),
            SectorConstituentSpec("DLR", "数字房地产", 4.9),
            SectorConstituentSpec("O", "Realty Inc", 4.6),
            SectorConstituentSpec("CBRE", "世邦魏理仕", 3.9),
            SectorConstituentSpec("CCI", "冠城国际", 3.7),
        ),
    ),
    SectorHeatmapSpec(
        symbol="XLB",
        name_zh="基础材料与金属化工",
        short_zh="材料",
        market_weight_pct=2.1,
        constituents=(
            SectorConstituentSpec("LIN", "林德气体", 18.6),
            SectorConstituentSpec("SHW", "宣伟涂料", 7.8),
            SectorConstituentSpec("FCX", "自由港铜金", 6.2),
            SectorConstituentSpec("APD", "空气化工", 5.4),
            SectorConstituentSpec("ECL", "艺康集团", 5.3),
            SectorConstituentSpec("NEM", "纽蒙特黄金", 4.9),
            SectorConstituentSpec("CTVA", "科迪华农化", 4.5),
            SectorConstituentSpec("NUE", "纽柯钢铁", 4.1),
            SectorConstituentSpec("DD", "杜邦", 3.8),
            SectorConstituentSpec("PPG", "PPG工业", 3.4),
        ),
    ),
)


def _all_heatmap_symbols() -> list[str]:
    syms = ["SPY"]
    for sec in SECTOR_HEATMAP_CATALOG:
        syms.append(sec.symbol)
        for c in sec.constituents:
            syms.append(c.symbol)
    return syms


async def _fetch_yahoo_chart_metrics(symbol: str) -> dict[str, Any]:
    yahoo_sym = symbol.replace(".", "-")
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_sym}"
    async with httpx.AsyncClient(
        timeout=10.0,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
    ) as client:
        resp = await client.get(url, params={"range": "2mo", "interval": "1d"})
        if resp.status_code != 200:
            return {}
        res = (resp.json().get("chart") or {}).get("result") or []
        if not res:
            return {}
        meta = res[0].get("meta") or {}
        closes_raw = (((res[0].get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
        closes = [float(x) for x in closes_raw if x is not None]
        if len(closes) < 2:
            return {}
        spot = float(meta.get("regularMarketPrice") or closes[-1])
        prev = float(meta.get("previousClose") or closes[-2])
        ret_1d = round(((spot - prev) / prev) * 100.0, 2) if prev > 0 else None
        ret_5d = (
            round(((spot - closes[-6]) / closes[-6]) * 100.0, 2)
            if len(closes) >= 6 and closes[-6] > 0
            else None
        )
        ret_20d = (
            round(((spot - closes[-21]) / closes[-21]) * 100.0, 2)
            if len(closes) >= 21 and closes[-21] > 0
            else None
        )
        return {
            "price": round(spot, 2),
            "return_1d_pct": ret_1d,
            "return_5d_pct": ret_5d,
            "return_20d_pct": ret_20d,
        }


async def _compute_sector_heatmap_raw(
    *,
    settings: Settings,
    cache: DualTTLCache | None,
    overview_sector_rotation: list[dict[str, Any]] | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    overview_map = {
        str(row.get("symbol", "")).upper(): row
        for row in (overview_sector_rotation or [])
        if row.get("symbol")
    }

    snapshots: dict[str, dict[str, Any]] = {}
    if settings.alpaca_api_key.strip() and settings.alpaca_secret_key.strip():
        alpaca = AlpacaClient(settings, cache=cache)
        try:
            snapshots = await alpaca.get_batch_stock_snapshots(
                _all_heatmap_symbols(),
                force_refresh=force_refresh,
            )
        except (ProviderError, httpx.HTTPError, OSError, RuntimeError, ValueError):
            snapshots = {}

    missing_etf_stats = any(
        sec.symbol not in overview_map or sec.symbol not in snapshots
        for sec in SECTOR_HEATMAP_CATALOG
    )
    yahoo_etf_map: dict[str, dict[str, Any]] = {}
    if missing_etf_stats:
        etf_syms = ["SPY", *[s.symbol for s in SECTOR_HEATMAP_CATALOG]]
        results = await asyncio.gather(
            *[_fetch_yahoo_chart_metrics(sym) for sym in etf_syms],
            return_exceptions=True,
        )
        for sym, res in zip(etf_syms, results):
            if isinstance(res, dict) and res:
                yahoo_etf_map[sym] = res

    spy_ret_20d = overview_map.get("XLK", {}).get("spy_return_20d_pct")
    if spy_ret_20d is None:
        spy_ret_20d = yahoo_etf_map.get("SPY", {}).get("return_20d_pct")

    sectors_out: list[dict[str, Any]] = []
    for sec in SECTOR_HEATMAP_CATALOG:
        ov = overview_map.get(sec.symbol, {})
        snap = snapshots.get(sec.symbol, {})
        yh = yahoo_etf_map.get(sec.symbol, {})

        price = snap.get("price") or yh.get("price") or ov.get("last_close")
        ret_1d = snap.get("change_1d_pct") if snap.get("change_1d_pct") is not None else yh.get("return_1d_pct")
        if ret_1d is None:
            ret_1d = ov.get("return_1d_pct")
        ret_5d = ov.get("return_5d_pct") if ov.get("return_5d_pct") is not None else yh.get("return_5d_pct")
        ret_20d = ov.get("return_20d_pct") if ov.get("return_20d_pct") is not None else yh.get("return_20d_pct")
        rel_spy = ov.get("rel_spy_20d_pct")
        if rel_spy is None and ret_20d is not None and spy_ret_20d is not None:
            rel_spy = round(float(ret_20d) - float(spy_ret_20d), 2)

        constituents_out: list[dict[str, Any]] = []
        up_count = 0
        for comp in sec.constituents:
            c_snap = snapshots.get(comp.symbol, {})
            c_chg = c_snap.get("change_1d_pct")
            if c_chg is not None and float(c_chg) > 0:
                up_count += 1
            constituents_out.append(
                {
                    "symbol": comp.symbol,
                    "name_zh": comp.name_zh,
                    "weight_pct": comp.weight_in_sector_pct,
                    "price": c_snap.get("price"),
                    "change_1d_pct": c_chg,
                }
            )

        sectors_out.append(
            {
                "symbol": sec.symbol,
                "name_zh": sec.name_zh,
                "short_zh": sec.short_zh,
                "market_weight_pct": sec.market_weight_pct,
                "price": price,
                "return_1d_pct": ret_1d,
                "return_5d_pct": ret_5d,
                "return_20d_pct": ret_20d,
                "rel_spy_20d_pct": rel_spy,
                "advancers_top6": up_count,
                "constituents": constituents_out,
            }
        )

    ranked_1d = sorted(
        [s for s in sectors_out if s["return_1d_pct"] is not None],
        key=lambda x: float(x["return_1d_pct"]),
        reverse=True,
    )
    if len(ranked_1d) >= 4:
        leaders = "、".join(
            f"{s['short_zh']}({s['return_1d_pct']:+.2f}%)" for s in ranked_1d[:2]
        )
        laggards = "、".join(
            f"{s['short_zh']}({s['return_1d_pct']:+.2f}%)" for s in ranked_1d[-2:]
        )
        summary_zh = f"今日主线领涨：{leaders}；资金承压流出：{laggards}"
    else:
        summary_zh = "美股 11 大 GICS 板块实时轮动与重仓龙头动向"

    return {
        "status": "ok",
        "source": "alpaca_snapshots" if snapshots else "yahoo_overview_fallback",
        "summary_zh": summary_zh,
        "sectors": sectors_out,
    }


async def build_sector_heatmap_payload(
    *,
    settings: Settings,
    cache: DualTTLCache | None,
    overview_sector_rotation: list[dict[str, Any]] | None = None,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Build 11-sector market-weight heatmap enriched with 110 top constituent leaders."""
    cache_key = "marketelite:market:sector-heatmap:v2"
    if cache is None:
        return await _compute_sector_heatmap_raw(
            settings=settings,
            cache=None,
            overview_sector_rotation=overview_sector_rotation,
            force_refresh=force_refresh,
        )

    res = await cache.get_or_fetch(
        cache_key,
        provider="sector_heatmap",
        fetcher=lambda: _compute_sector_heatmap_raw(
            settings=settings,
            cache=cache,
            overview_sector_rotation=overview_sector_rotation,
            force_refresh=force_refresh,
        ),
        soft_ttl_seconds=120,
        hard_ttl_seconds=86400,
        force_refresh=force_refresh,
    )
    payload = res.data if isinstance(res.data, dict) else {}
    return {
        **payload,
        "is_stale": res.is_stale,
        "cache_status": res.cache_status,
        "fetched_at": res.fetched_at,
    }
