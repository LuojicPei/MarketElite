"""Real-time Market Movers & Most-Active Volume leaderboard across the entire US market (NYSE/NASDAQ)."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import Settings
from app.db.models import MarketDailyBar
from app.services.providers.alpaca import AlpacaClient
from app.services.resilience import DualTTLCache, ProviderError

_INDUSTRY_ZH_MAP: dict[str, str] = {
    "biotechnology": "生物科技",
    "pharmaceuticals": "医药制药",
    "health care": "医疗健康",
    "healthcare": "医疗健康",
    "medical": "医疗器械",
    "life sciences tools & services": "生命科学",
    "semiconductors": "半导体芯片",
    "semiconductors & semiconductor equipment": "半导体装备",
    "electrical equipment": "电力设备",
    "software": "软件云计算",
    "technology hardware, storage & peripherals": "科技硬件",
    "electronic equipment, instruments & components": "电子元器件",
    "communications": "通信网络",
    "media": "传媒娱乐",
    "entertainment": "文娱流媒",
    "interactive media & services": "互联网",
    "internet": "互联网",
    "oil, gas & consumable fuels": "油气能源",
    "energy": "能源资源",
    "metals & mining": "金属矿产",
    "gold": "黄金贵金属",
    "financial services": "金融服务",
    "banking": "银行金融",
    "banks": "银行金融",
    "capital markets": "资本投行",
    "insurance": "保险金融",
    "automobiles": "新能源汽车",
    "auto components": "汽车配件",
    "aerospace & defense": "航空防务",
    "machinery": "机械装备",
    "industrial": "工业制造",
    "retail": "消费零售",
    "specialty retail": "专业零售",
    "real estate": "房地产",
    "utilities": "公用电力",
    "airlines": "航空运输",
    "marine": "航运物流",
    "transportation": "物流运输",
    "chemicals": "化工材料",
    "construction": "工程建筑",
    "building": "建筑建材",
    "food products": "食品消费",
    "beverages": "饮品消费",
    "hotels, restaurants & leisure": "休闲餐饮",
    "commercial services & supplies": "商业服务",
    "professional services": "专业服务",
    "telecommunication": "电信运营",
    "consumer": "消费品",
    "logistics": "供应链物流",
}


def _map_industry_zh(raw_industry: str | None) -> str:
    ind = str(raw_industry or "").strip()
    if not ind or ind.upper() in {"N/A", "NONE", "UNKNOWN"}:
        return "美股成长"
    low = ind.lower()
    if low in _INDUSTRY_ZH_MAP:
        return _INDUSTRY_ZH_MAP[low]
    for k, zh in _INDUSTRY_ZH_MAP.items():
        if k in low:
            return zh
    if "tech" in low:
        return "科技企业"
    if "bio" in low or "pharma" in low or "drug" in low:
        return "生物医药"
    if "oil" in low or "gas" in low or "petro" in low:
        return "油气能源"
    if "solar" in low or "power" in low or "electric" in low or "renew" in low:
        return "新能源电"
    if "mine" in low or "gold" in low or "copper" in low or "steel" in low:
        return "矿产材料"
    if "bank" in low or "financ" in low or "invest" in low or "credit" in low:
        return "金融资本"
    if "ship" in low or "freight" in low or "cargo" in low:
        return "航运物流"
    return ind[:10] if len(ind) <= 10 else "美股活跃"


def _shorten_company_name(raw_name: str | None, fallback_sym: str) -> str:
    name = str(raw_name or "").strip()
    if not name:
        return fallback_sym
    for suffix in (
        ", Inc.",
        " Inc.",
        " Inc",
        ", Corp.",
        " Corp.",
        " Corp",
        " Holdings Ltd",
        " Holdings Limited",
        " Holdings Inc",
        " Holdings",
        " Group Ltd",
        " Group",
        " Limited",
        " Ltd.",
        " Ltd",
        " PLC",
        " plc",
        " N.V.",
        " S.A.",
        " Co.",
    ):
        if name.endswith(suffix):
            name = name[: -len(suffix)].strip(" ,.")
    return name[:20] if len(name) > 20 else name


_LEVERAGED_ETF_KEYWORDS: tuple[str, ...] = (
    "2x",
    "3x",
    "1.5x",
    "1.75x",
    "-1x",
    "-2x",
    "-3x",
    "ultra ",
    "ultrashort",
    "ultrapro",
    "inverse",
    "proshares",
    "direxion",
    "graniteshares",
    "t-rex",
    "defiance",
    "tradr",
    "leverage shares",
    "microsectors",
    "2x做多",
    "2x做空",
    "3x做多",
    "3x做空",
    "杠杆",
    "反向做空etf",
)

# Common high-turnover US leveraged / inverse ETP tickers caught before enrichment fallback
_KNOWN_LEVERAGED_ETF_SYMBOLS: frozenset[str] = frozenset(
    {
        "SOXL",
        "SOXS",
        "TQQQ",
        "SQQQ",
        "QLD",
        "QID",
        "SSO",
        "SDS",
        "SPXL",
        "SPXS",
        "UPRO",
        "SPXU",
        "SPDN",
        "TNA",
        "TZA",
        "UDOW",
        "SDOW",
        "LABU",
        "LABD",
        "BOIL",
        "KOLD",
        "UVXY",
        "UVIX",
        "SVIX",
        "SVXY",
        "VXX",
        "VIXY",
        "TMF",
        "TMV",
        "TECL",
        "TECS",
        "FNGU",
        "FNGD",
        "NVD",
        "NVDL",
        "NVDU",
        "NVDD",
        "NVDX",
        "NVDQ",
        "TSLL",
        "TSLQ",
        "TSLS",
        "TSLT",
        "MSTU",
        "MSTX",
        "MSTZ",
        "CONL",
        "METU",
        "AAPU",
        "AAPD",
        "AMZU",
        "AMZD",
        "MSFU",
        "MSFD",
        "GGLL",
        "GGLS",
        "BITX",
        "BITU",
        "SBIT",
        "ETHU",
        "ETHD",
        "YINN",
        "YANG",
        "BULZ",
        "BERZ",
        "DRIP",
        "GUSH",
        "NUGT",
        "DUST",
        "JNUG",
        "JDST",
        "AGQ",
        "ZSL",
        "UCO",
        "SCO",
        "FAS",
        "FAZ",
        "CURE",
        "DRN",
        "DRV",
        "DPST",
        "NAIL",
        "WEBL",
        "WEBS",
        "HIBL",
        "HIBS",
        "DFEN",
        "RETL",
        "WANT",
        "MIDU",
        "TYD",
        "TYO",
        "TBT",
        "SH",
        "PSQ",
        "DOG",
        "RWM",
        "DXD",
        "QBTZ",
        "IONX",
        "IONZ",
        "RKLX",
        "OKLL",
        "SMCX",
        "PLTU",
        "PLTD",
        "HOOX",
        "MUU",
        "ARMG",
    }
)


def is_leveraged_or_inverse_etf(
    symbol: str,
    name: str | None = None,
    theme_zh: str | None = None,
) -> bool:
    """Return True if ticker is a leveraged or inverse ETF/ETN that would crowd stock movers."""
    sym = symbol.upper().strip()
    if sym in _KNOWN_LEVERAGED_ETF_SYMBOLS:
        return True
    t_str = str(theme_zh or "").strip()
    if t_str in {"杠杆ETF", "杠杆做多ETF", "反向做空ETF"} or "杠杆" in t_str or "反向做空" in t_str:
        return True
    low = str(name or "").lower()
    return any(tok in low for tok in _LEVERAGED_ETF_KEYWORDS)


def _infer_theme_from_name(raw_name: str | None, quote_type: str | None = None) -> str | None:
    """Infer concise Chinese sector/category badge from asset name or ETF quoteType."""
    low = str(raw_name or "").lower()
    qt = str(quote_type or "").upper()
    if qt == "ETF" or any(k in low for k in ("etf", "etn", "2x", "3x", "1.5x", "-2x", "-1x", "-3x", "bear ", "bull ", "proshares", "direxion", "graniteshares", "t-rex", "defiance", "tradr", "yieldmax", "roundhill", "ultrashort", "ultrapro")):
        if any(k in low for k in ("bear", "short", "inverse", "-1x", "-2x", "-3x", "ultrashort")):
            return "反向做空ETF"
        if any(k in low for k in ("2x", "3x", "1.5x", "1.75x", "bull", "long", "ultra", "leverage")):
            return "杠杆做多ETF"
        if "yield" in low or "income" in low or "option" in low or "dividend" in low:
            return "高息期权ETF"
        return "主题/策略ETF"
    if any(k in low for k in ("pharma", "therapeut", "bio", "medic", "oncol", "genom", "health", "clinic", "diagnos")):
        return "生物医药"
    if any(k in low for k in ("semicond", "chip", "microelec", "photonic", "laser", "silicon", "quantum", "ai ", "cloud", "cyber", "software")):
        return "科技半导体"
    if any(k in low for k in ("energy", "solar", "power", "electric", "battery", "oil", "gas", "petro", "uranium", "nuclear", "hydro")):
        return "能源电力"
    if any(k in low for k in ("mining", "gold", "silver", "copper", "lithium", "metal", "steel")):
        return "矿产资源"
    if any(k in low for k in ("equipment", "industrial", "machin", "manuf", "aerospace", "defense", "robot", "auto", "motor")):
        return "高端工业"
    if any(k in low for k in ("bank", "financ", "capital", "credit", "insur", "invest", "acquisit")):
        return "金融资本"
    if any(k in low for k in ("ship", "marine", "tanker", "freight", "cargo", "airline", "logistic")):
        return "航运物流"
    if any(k in low for k in ("retail", "consumer", "apparel", "food", "beverage", "restaurant", "media", "gaming")):
        return "消费文娱"
    return None


async def _enrich_unknown_profiles(
    symbols: list[str],
    *,
    cache: DualTTLCache,
    settings: Settings,
) -> dict[str, tuple[str, str]]:
    """Resolve short company name + Chinese industry/ETF badge via Finnhub profile2 + Yahoo Search fallback (30D Redis cache)."""
    unknown = sorted({s.upper().strip() for s in symbols if s and s.upper().strip() not in MOVERS_UNIVERSE})
    if not unknown:
        return {}

    profiles: dict[str, tuple[str, str]] = {}
    to_fetch: list[str] = []

    read_tasks = [cache.read_envelope(f"marketelite:mover:profile:v2:{sym}") for sym in unknown]
    cached_envs = await asyncio.gather(*read_tasks, return_exceptions=True)
    for sym, env in zip(unknown, cached_envs, strict=False):
        if isinstance(env, dict) and isinstance(env.get("payload"), dict):
            p = env["payload"]
            n_zh = str(p.get("name_zh") or sym)
            t_zh = str(p.get("theme_zh") or "")
            if t_zh:
                profiles[sym] = (n_zh, t_zh)
                continue
        to_fetch.append(sym)

    api_key = settings.finnhub_api_key.strip()
    if not to_fetch:
        return profiles

    # Bound live profile enrichment per refresh cycle so latency stays fast (<1.8s)
    batch = to_fetch[:75]
    sem = asyncio.Semaphore(10)

    async def _fetch_one(client: httpx.AsyncClient, sym: str) -> None:
        async with sem:
            name_zh = ""
            theme_zh = ""
            raw_name = ""
            src = "finnhub_profile2"
            if api_key:
                try:
                    resp = await client.get(
                        "https://finnhub.io/api/v1/stock/profile2",
                        params={"symbol": sym, "token": api_key},
                        timeout=4.5,
                    )
                    if resp.status_code == 200:
                        body = resp.json() or {}
                        if isinstance(body, dict) and (body.get("name") or body.get("finnhubIndustry")):
                            raw_name = str(body.get("name") or "")
                            name_zh = _shorten_company_name(raw_name, sym)
                            ind = str(body.get("finnhubIndustry") or "").strip()
                            mapped = _map_industry_zh(ind) if ind else ""
                            inferred = _infer_theme_from_name(raw_name)
                            if inferred in {"杠杆做多ETF", "反向做空ETF"}:
                                theme_zh = inferred
                            elif mapped and mapped not in {"美股成长", "美股活跃"}:
                                theme_zh = mapped
                            else:
                                theme_zh = inferred or mapped or ""
                except (httpx.HTTPError, OSError, ValueError):
                    pass

            if not theme_zh or not name_zh or name_zh == sym:
                try:
                    yresp = await client.get(
                        "https://query1.finance.yahoo.com/v1/finance/search",
                        params={"q": sym, "quotesCount": 3, "newsCount": 0},
                        headers={"User-Agent": "Mozilla/5.0"},
                        timeout=4.5,
                    )
                    if yresp.status_code == 200:
                        ydata = yresp.json() or {}
                        quotes = [q for q in (ydata.get("quotes") or []) if isinstance(q, dict)]
                        exact = next(
                            (q for q in quotes if str(q.get("symbol") or "").upper() == sym),
                            quotes[0] if quotes else None,
                        )
                        if exact:
                            src = "yahoo_search"
                            yname = str(exact.get("shortname") or exact.get("longname") or raw_name or sym)
                            if not name_zh or name_zh == sym:
                                name_zh = _shorten_company_name(yname, sym)
                            qt = str(exact.get("quoteType") or "")
                            ind = str(exact.get("industryDisp") or exact.get("industry") or exact.get("sectorDisp") or exact.get("sector") or "")
                            inferred = _infer_theme_from_name(yname, qt)
                            mapped = _map_industry_zh(ind) if ind else ""
                            if qt.upper() == "ETF" and inferred:
                                theme_zh = inferred
                            elif mapped and mapped not in {"美股成长", "美股活跃"}:
                                theme_zh = mapped
                            elif inferred:
                                theme_zh = inferred
                            elif mapped:
                                theme_zh = mapped
                except (httpx.HTTPError, OSError, ValueError):
                    pass

            if not theme_zh:
                return
            if not name_zh:
                name_zh = sym
            profiles[sym] = (name_zh, theme_zh)
            await cache.write_envelope(
                f"marketelite:mover:profile:v2:{sym}",
                payload={"name_zh": name_zh, "theme_zh": theme_zh},
                source=src,
                soft_ttl_seconds=86400 * 30,
                hard_ttl_seconds=86400 * 60,
            )

    async with httpx.AsyncClient() as client:
        await asyncio.gather(*(_fetch_one(client, s) for s in batch), return_exceptions=True)

    return profiles

# Institutional & popular thematic catalog used for Chinese names/sector badges + fallback scan
MOVERS_UNIVERSE: dict[str, tuple[str, str]] = {
    "AAPL": ("苹果", "七姐妹"),
    "MSFT": ("微软", "七姐妹"),
    "NVDA": ("英伟达", "AI算力"),
    "GOOGL": ("谷歌", "七姐妹"),
    "AMZN": ("亚马逊", "七姐妹"),
    "META": ("Meta", "七姐妹"),
    "TSLA": ("特斯拉", "自动驾驶"),
    "AVGO": ("博通", "AI算力"),
    "AMD": ("超威半导体", "AI算力"),
    "TSM": ("台积电", "芯片代工"),
    "MU": ("美光科技", "存储芯片"),
    "ARM": ("ARM", "芯片架构"),
    "ASML": ("阿斯麦", "光刻机"),
    "MRVL": ("迈威尔", "AI芯片"),
    "INTC": ("英特尔", "半导体"),
    "QCOM": ("高通", "移动芯片"),
    "TXN": ("德州仪器", "模拟芯片"),
    "AMAT": ("应用材料", "半导体设备"),
    "LRCX": ("泛林集团", "半导体设备"),
    "KLAC": ("科磊", "检测设备"),
    "SNDK": ("闪迪存储", "存储芯片"),
    "WDC": ("西部数据", "存储"),
    "COHR": ("Coherent", "CPO光通信"),
    "LITE": ("Lumentum", "CPO光通信"),
    "AXTI": ("AXT晶体", "光芯片材料"),
    "ALAB": ("Astera Labs", "AI互连"),
    "CRDO": ("Credo", "高速铜缆"),
    "VRT": ("Vertiv", "液冷基建"),
    "SMCI": ("超微电脑", "AI服务器"),
    "ANET": ("Arista", "数据中心网络"),
    "ORCL": ("甲骨文", "云与AI"),
    "CRM": ("赛富时", "SaaS软件"),
    "PLTR": ("Palantir", "AI应用"),
    "NOW": ("ServiceNow", "企业软件"),
    "ADBE": ("Adobe", "创意软件"),
    "PANW": ("Palo Alto", "网络安全"),
    "CRWD": ("CrowdStrike", "网络安全"),
    "SNOW": ("Snowflake", "云数据"),
    "DDOG": ("Datadog", "云监控"),
    "NET": ("Cloudflare", "边缘云"),
    "NFLX": ("奈飞", "流媒体"),
    "APP": ("AppLovin", "AI广告"),
    "ASTS": ("AST SpaceMobile", "商业航天"),
    "RKLB": ("Rocket Lab", "商业航天"),
    "LMT": ("洛克希德马丁", "军工防务"),
    "RTX": ("雷神技术", "军工防务"),
    "NOC": ("诺斯罗普", "军工防务"),
    "BA": ("波音", "航空制造"),
    "CAT": ("卡特彼勒", "基建机械"),
    "DE": ("迪尔股份", "高端制造"),
    "GE": ("GE航空", "工业龙头"),
    "VST": ("Vistra", "核电电力"),
    "CEG": ("Constellation", "核电电力"),
    "GEV": ("GE Vernova", "电网设备"),
    "CCJ": ("Cameco", "铀矿核燃料"),
    "OKLO": ("Oklo", "小型核电"),
    "NEE": ("NextEra", "新能源公用"),
    "COIN": ("Coinbase", "数字货币"),
    "MSTR": ("Strategy", "BTC概念"),
    "HOOD": ("Robinhood", "散户券商"),
    "SOFI": ("SoFi", "数字银行"),
    "PYPL": ("PayPal", "金融科技"),
    "V": ("Visa", "支付网络"),
    "MA": ("万事达", "支付网络"),
    "XYZ": ("Block", "数字支付"),
    "JPM": ("摩根大通", "华尔街大行"),
    "GS": ("高盛", "顶级投行"),
    "MS": ("摩根士丹利", "顶级投行"),
    "BAC": ("美国银行", "商业银行"),
    "WFC": ("富国银行", "商业银行"),
    "BLK": ("贝莱德", "资管巨头"),
    "BRK.B": ("伯克希尔", "价值旗舰"),
    "LLY": ("礼来", "GLP-1减肥药"),
    "NVO": ("诺和诺德", "GLP-1减肥药"),
    "UNH": ("联合健康", "医保龙头"),
    "ABBV": ("艾伯维", "创新药"),
    "MRK": ("默沙东", "制药龙头"),
    "ISRG": ("直觉外科", "手术机器人"),
    "TMO": ("赛默飞", "生命科学"),
    "WMT": ("沃尔玛", "防御零售"),
    "COST": ("开市客", "会员零售"),
    "HD": ("家得宝", "家居建材"),
    "LOW": ("劳氏", "家居零售"),
    "MCD": ("麦当劳", "快餐消费"),
    "NKE": ("耐克", "运动服饰"),
    "BKNG": ("Booking", "在线旅游"),
    "UBER": ("优步", "出行平台"),
    "XOM": ("埃克森美孚", "石油巨头"),
    "CVX": ("雪佛龙", "石油巨头"),
    "SLB": ("斯伦贝谢", "油服龙头"),
    "FCX": ("自由港", "铜矿资源"),
    "NEM": ("纽蒙特", "黄金开采"),
    "BABA": ("阿里巴巴", "中概互联"),
    "PDD": ("拼多多", "中概电商"),
    "BIDU": ("百度", "中概AI"),
    "SPY": ("标普500ETF", "核心宽基"),
    "QQQ": ("纳指100ETF", "核心宽基"),
    "IWM": ("罗素2000ETF", "中小盘"),
}

_CACHE_KEY = "marketelite:market:movers:v4"


def _is_clean_ticker(symbol: str) -> bool:
    """Filter out warrant/unit suffixes like FGIWW, SPACWS so real stocks surface cleanly."""
    sym = symbol.upper().strip()
    if not sym or len(sym) > 5 and "." not in sym:
        return False
    if len(sym) == 5 and sym.endswith(("W", "U", "R")):
        return False
    return not sym.endswith(("WW", "WS"))


async def _load_avg_volumes_from_db(
    session_factory: async_sessionmaker[Any],
    symbols: list[str],
) -> dict[str, tuple[float, float, float | None, float | None]]:
    """Return {sym: (latest_vol, avg_20d_vol, latest_close, prev_close)} from Postgres daily bars."""
    ranked = (
        select(
            MarketDailyBar.symbol,
            MarketDailyBar.trade_date,
            MarketDailyBar.close,
            MarketDailyBar.volume,
            func.row_number()
            .over(
                partition_by=MarketDailyBar.symbol,
                order_by=desc(MarketDailyBar.trade_date),
            )
            .label("rn"),
        )
        .where(MarketDailyBar.symbol.in_(symbols))
        .subquery()
    )
    stmt = (
        select(ranked)
        .where(ranked.c.rn <= 21)
        .order_by(ranked.c.symbol, ranked.c.rn)
    )
    async with session_factory() as session:
        rows = (await session.execute(stmt)).all()

    grouped: dict[str, list[Any]] = {}
    for row in rows:
        grouped.setdefault(str(row.symbol), []).append(row)

    out: dict[str, tuple[float, float, float | None, float | None]] = {}
    for sym, items in grouped.items():
        latest_c = float(items[0].close) if items else None
        latest_v = float(items[0].volume) if items else 0.0
        prev_c = float(items[1].close) if len(items) > 1 else None
        vols = [float(it.volume) for it in items[1:21] if float(it.volume) > 0]
        if not vols and items:
            vols = [float(it.volume) for it in items if float(it.volume) > 0]
        avg_v = sum(vols) / len(vols) if vols else 0.0
        out[sym] = (latest_v, avg_v, latest_c, prev_c)
    return out


async def _fetch_alpaca_snapshots(
    settings: Settings,
    symbols: list[str],
) -> dict[str, dict[str, Any]]:
    """Batch fetch Alpaca IEX snapshots (latest price, change %, volume, prev volume)."""
    client_helper = AlpacaClient(settings)
    headers = client_helper._headers()
    out: dict[str, dict[str, Any]] = {}
    clean_syms = sorted({s.upper().strip() for s in symbols if s.strip()})
    chunks = [clean_syms[i : i + 50] for i in range(0, len(clean_syms), 50)]
    async def _fetch_chunk(client: httpx.AsyncClient, chunk: list[str]) -> dict[str, Any]:
        resp = await client.get(
            f"{client_helper.DATA_BASE}/v2/stocks/snapshots",
            headers=headers,
            params={"symbols": ",".join(chunk), "feed": "iex"},
            timeout=15.0,
        )
        if resp.status_code != 200:
            return {}
        return resp.json() or {}

    async with httpx.AsyncClient() as client:
        chunk_bodies = await asyncio.gather(
            *(_fetch_chunk(client, chunk) for chunk in chunks),
            return_exceptions=True,
        )

    for body in chunk_bodies:
        if isinstance(body, BaseException) or not isinstance(body, dict):
            continue
        for sym, snap in body.items():
                daily = snap.get("dailyBar") or {}
                prev = snap.get("prevDailyBar") or {}
                trade = snap.get("latestTrade") or {}
                curr = trade.get("p") or daily.get("c") or prev.get("c")
                prev_c = prev.get("c")
                if curr is None:
                    continue
                curr_f = float(curr)
                prev_f = float(prev_c) if prev_c else None
                chg_pct = (
                    round(((curr_f - prev_f) / prev_f) * 100.0, 2)
                    if prev_f and prev_f > 0
                    else None
                )
                daily_v = float(daily.get("v") or 0)
                prev_v = float(prev.get("v") or 0)
                active_v = daily_v if daily_v > 0 else prev_v
                out[sym] = {
                    "price": round(curr_f, 2),
                    "prev_close": round(prev_f, 2) if prev_f is not None else None,
                    "change_1d_pct": chg_pct,
                    "volume": active_v,
                    "prev_volume": prev_v,
                    "daily_date": str(daily.get("t") or "")[:10],
                    "prev_date": str(prev.get("t") or "")[:10],
                }
    return out


async def _fetch_alpaca_screener_market_wide(
    settings: Settings,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Fetch whole-US-market Top 50 Gainers, Losers, and Most-Active Volume via Alpaca Screener."""
    client_helper = AlpacaClient(settings)
    headers = client_helper._headers()
    async with httpx.AsyncClient() as client:
        movers_resp = await client.get(
            f"{client_helper.DATA_BASE}/v1beta1/screener/stocks/movers",
            headers=headers,
            params={"top": 50},
            timeout=12.0,
        )
        actives_resp = await client.get(
            f"{client_helper.DATA_BASE}/v1beta1/screener/stocks/most-actives",
            headers=headers,
            params={"by": "volume", "top": 50},
            timeout=12.0,
        )
    movers_json = movers_resp.json() if movers_resp.status_code == 200 else {}
    actives_json = actives_resp.status_code == 200 and actives_resp.json() or {}
    return (
        list(movers_json.get("gainers") or []),
        list(movers_json.get("losers") or []),
        list((actives_json if isinstance(actives_json, dict) else {}).get("most_actives") or []),
    )


def _rank_top20(
    items: list[dict[str, Any]],
    *,
    min_price: float,
    sort_key: str,
    reverse: bool,
) -> list[dict[str, Any]]:
    seen: set[str] = set()
    filtered: list[dict[str, Any]] = []
    for item in items:
        sym = str(item["symbol"])
        if sym in seen:
            continue
        if is_leveraged_or_inverse_etf(
            sym,
            name=str(item.get("name_zh") or ""),
            theme_zh=str(item.get("theme_zh") or ""),
        ):
            continue
        if min_price > 0 and (item["price"] < min_price or not _is_clean_ticker(sym)):
            continue
        seen.add(sym)
        filtered.append(item)

    filtered.sort(key=lambda r: float(r.get(sort_key) or 0.0), reverse=reverse)
    return filtered[:20]


async def build_market_movers_payload(
    *,
    session_factory: async_sessionmaker[Any],
    cache: DualTTLCache,
    settings: Settings,
    min_price: float = 2.0,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Build market-wide Top 20 Gainers, Losers & Volume Leaders across NYSE/NASDAQ."""
    base_symbols = list(MOVERS_UNIVERSE.keys())

    async def _compute_raw_pool() -> dict[str, Any]:
        scr_gainers: list[dict[str, Any]] = []
        scr_losers: list[dict[str, Any]] = []
        scr_actives: list[dict[str, Any]] = []
        try:
            scr_gainers, scr_losers, scr_actives = await _fetch_alpaca_screener_market_wide(settings)
        except (ProviderError, httpx.HTTPError, OSError):
            pass

        screener_syms: list[str] = []
        screener_meta: dict[str, dict[str, Any]] = {}
        for row in scr_gainers + scr_losers:
            sym = str(row.get("symbol", "")).upper().strip()
            if not sym:
                continue
            screener_syms.append(sym)
            screener_meta[sym] = {
                "price": round(float(row.get("price") or 0), 2),
                "change_1d_pct": round(float(row.get("percent_change") or 0), 2),
                "source": "screener",
            }
        active_map: dict[str, float] = {}
        for row in scr_actives:
            sym = str(row.get("symbol", "")).upper().strip()
            if not sym:
                continue
            screener_syms.append(sym)
            active_map[sym] = float(row.get("volume") or 0.0)

        all_syms = sorted(set(base_symbols) | set(screener_syms))
        db_stats = await _load_avg_volumes_from_db(session_factory, base_symbols)
        live_snaps: dict[str, dict[str, Any]] = {}
        try:
            live_snaps = await _fetch_alpaca_snapshots(settings, all_syms)
        except (ProviderError, httpx.HTTPError, OSError):
            live_snaps = {}

        priority_unknowns: list[str] = []
        seen_unk: set[str] = set()
        for row in scr_gainers + scr_losers + scr_actives:
            s = str(row.get("symbol", "")).upper().strip()
            if (
                s
                and s not in MOVERS_UNIVERSE
                and s not in seen_unk
                and _is_clean_ticker(s)
                and not is_leveraged_or_inverse_etf(s)
            ):
                seen_unk.add(s)
                priority_unknowns.append(s)
        extra_profiles = await _enrich_unknown_profiles(
            priority_unknowns, cache=cache, settings=settings
        )

        records: list[dict[str, Any]] = []
        for sym in all_syms:
            meta_pair = MOVERS_UNIVERSE.get(sym) or extra_profiles.get(sym)
            name_zh = meta_pair[0] if meta_pair else sym
            theme_zh = meta_pair[1] if meta_pair else ("高频成交" if sym in active_map else "个股异动")
            if is_leveraged_or_inverse_etf(sym, name=name_zh, theme_zh=theme_zh):
                continue

            snap = live_snaps.get(sym)
            scr = screener_meta.get(sym)
            db_latest_vol, db_avg_vol, db_c, db_prev = db_stats.get(sym, (0.0, 0.0, None, None))

            price: float | None = None
            chg_pct: float | None = None
            vol: float = active_map.get(sym, 0.0)
            rvol: float = 1.0

            if scr and scr.get("price"):
                price = float(scr["price"])
                chg_pct = float(scr["change_1d_pct"])
            if snap and snap.get("price") is not None:
                if price is None:
                    price = float(snap["price"])
                if chg_pct is None and snap.get("change_1d_pct") is not None:
                    chg_pct = float(snap["change_1d_pct"])
                snap_v = float(snap.get("volume") or 0.0)
                if vol <= 0:
                    vol = snap_v
                prev_v = float(snap.get("prev_volume") or 0.0)
                if snap_v > 0 and prev_v > 0 and snap.get("daily_date") != snap.get("prev_date"):
                    rvol = round(snap_v / prev_v, 2)
                elif db_avg_vol > 0 and db_latest_vol > 0:
                    rvol = round(db_latest_vol / db_avg_vol, 2)
            elif price is None and db_c is not None and db_prev and db_prev > 0:
                price = round(db_c, 2)
                chg_pct = round(((db_c / db_prev) - 1.0) * 100.0, 2)
                if vol <= 0:
                    vol = db_latest_vol or db_avg_vol
                rvol = round(db_latest_vol / db_avg_vol, 2) if db_avg_vol > 0 and db_latest_vol > 0 else 1.0

            if price is None or price <= 0 or chg_pct is None:
                continue

            dollar_vol_m = round((price * vol) / 1_000_000.0, 1) if vol > 0 else 0.0
            records.append(
                {
                    "symbol": sym,
                    "name_zh": name_zh,
                    "theme_zh": theme_zh,
                    "price": round(price, 2),
                    "change_1d_pct": round(chg_pct, 2),
                    "rvol": rvol,
                    "dollar_vol_m": dollar_vol_m,
                    "volume_m": round(vol / 1_000_000.0, 2) if vol > 0 else 0.0,
                    "is_market_wide": sym in screener_meta or sym in active_map,
                }
            )

        return {
            "as_of": datetime.now(timezone.utc).isoformat(),
            "screener_active": bool(scr_gainers or scr_losers or scr_actives),
            "pool_count": len(records),
            "records": records,
        }

    if force_refresh:
        raw = await _compute_raw_pool()
        await cache.write_envelope(
            _CACHE_KEY,
            payload=raw,
            source="alpaca_market_screener",
            soft_ttl_seconds=120,
            hard_ttl_seconds=1800,
        )
        is_stale = False
    else:
        res = await cache.get_or_fetch(
            _CACHE_KEY,
            provider="alpaca_screener",
            fetcher=_compute_raw_pool,
            soft_ttl_seconds=120,
            hard_ttl_seconds=1800,
        )
        raw = dict(res.data) if isinstance(res.data, dict) else await _compute_raw_pool()
        is_stale = res.is_stale

    records = list(raw.get("records") or [])
    gainers = _rank_top20(records, min_price=min_price, sort_key="change_1d_pct", reverse=True)
    losers = _rank_top20(records, min_price=min_price, sort_key="change_1d_pct", reverse=False)
    unusual = _rank_top20(records, min_price=min_price, sort_key="dollar_vol_m", reverse=True)

    summary_zh = (
        f"全市场{('≥$' + str(int(min_price))) if min_price > 0 else '无门槛'}领涨 {gainers[0]['symbol']} {gainers[0]['change_1d_pct']:+.1f}% · "
        f"重挫 {losers[0]['symbol']} {losers[0]['change_1d_pct']:+.1f}%"
        if gainers and losers
        else "全美股异动龙虎榜实时扫描"
    )

    return {
        "status": "ok",
        "universe_count": raw.get("pool_count", len(records)),
        "screener_active": bool(raw.get("screener_active", False)),
        "min_price": min_price,
        "as_of": raw.get("as_of") or datetime.now(timezone.utc).isoformat(),
        "summary_zh": summary_zh,
        "top_gainers": gainers,
        "top_losers": losers,
        "unusual_volume": unusual,
        "is_stale": is_stale,
    }
