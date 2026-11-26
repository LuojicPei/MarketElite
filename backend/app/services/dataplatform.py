from __future__ import annotations

import json
import logging
import re
import time
from collections import Counter
from datetime import date, datetime, timezone
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import (
    ConsensusEpsSnapshot,
    EconomicCalendarEvent,
    EpisodicMemory,
    EvalRun,
    ImportedHolding,
    InvestigatorThread,
    MacroSeriesPoint,
    MarketDailyBar,
    MarketRegimeDaily,
    OptionsGexSnapshot,
    PaperTrade,
    SecFilingChunk,
    SecFilingDocument,
    TradeReview,
    UserWatchlistItem,
    WatchdogAlert,
)
from app.rag.hybrid_search import HybridSecRetriever
from app.services.news_discover import DISCOVER_CACHE_KEY

logger = logging.getLogger(__name__)

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

_TABLE_REGISTRY: tuple[dict[str, Any], ...] = (
    {
        "model": MarketDailyBar,
        "table": "market_daily_bars",
        "title_zh": "美股与加密日线行情",
        "layer": "DWD",
        "desc_zh": "经 NY 时区与复权统一后的核心标的日频 OHLCV + VWAP 主表",
        "date_col": "trade_date",
        "entity_col": "symbol",
        "sla_hours": 72,
    },
    {
        "model": MacroSeriesPoint,
        "table": "macro_series",
        "title_zh": "宏观流动性与利率序列",
        "layer": "DWD",
        "desc_zh": "FRED 美联储总资产 / TGA / RRP / 2Y·10Y·实际利率与高收益利差",
        "date_col": "obs_date",
        "entity_col": "series_id",
        "sla_hours": 240,
    },
    {
        "model": MarketRegimeDaily,
        "table": "market_regime_daily",
        "title_zh": "每日市场体制快照",
        "layer": "DWS",
        "desc_zh": "零 Token 确定的五维体制判断、净活水、广度与 Fear & Greed 历史",
        "date_col": "regime_date",
        "entity_col": None,
        "sla_hours": 72,
    },
    {
        "model": OptionsGexSnapshot,
        "table": "options_gex_snapshots",
        "title_zh": "期权做市商 GEX 快照",
        "layer": "DWS",
        "desc_zh": "期权链 Call/Put Wall、Zero Gamma 转折位与 OI 分布持久化快照",
        "date_col": "snapshot_time",
        "entity_col": "symbol",
        "sla_hours": 72,
    },
    {
        "model": EconomicCalendarEvent,
        "table": "economic_calendar",
        "title_zh": "美股宏观与财报日历",
        "layer": "DWD",
        "desc_zh": "FOMC / FRED / FMP / Finnhub 统一美东时间催化剂事件流",
        "date_col": "event_time",
        "entity_col": "symbol",
        "sla_hours": 168,
    },
    {
        "model": ConsensusEpsSnapshot,
        "table": "consensus_eps_snapshots",
        "title_zh": "华尔街盈利一致预期",
        "layer": "DWS",
        "desc_zh": "Finnhub EPS 季度一致预期及修正幅度快照",
        "date_col": "snapshot_date",
        "entity_col": "symbol",
        "sla_hours": 336,
    },
    {
        "model": SecFilingDocument,
        "table": "sec_filing_cache",
        "title_zh": "SEC EDGAR 财报元数据",
        "layer": "ODS",
        "desc_zh": "按需解析归档的 10-K / 10-Q / 8-K 官方索引记录",
        "date_col": "filing_date",
        "entity_col": "symbol",
        "sla_hours": None,
    },
    {
        "model": SecFilingChunk,
        "table": "sec_filing_chunks",
        "title_zh": "SEC 财报混合向量切片",
        "layer": "DWS",
        "desc_zh": "章节感知切块（Item 1A/7/8），双挂载 pgvector(1536) 与 GIN BM25",
        "date_col": "filing_date",
        "entity_col": "symbol",
        "sla_hours": None,
    },
    {
        "model": EpisodicMemory,
        "table": "episodic_memories",
        "title_zh": "情景记忆与 Playbook 库",
        "layer": "DWS",
        "desc_zh": "平仓复盘沉淀与人工置顶铁律，混合检索动态注入 Critic/Investigator",
        "date_col": "created_at",
        "entity_col": "symbol",
        "sla_hours": None,
    },
    {
        "model": InvestigatorThread,
        "table": "investigator_threads",
        "title_zh": "AI 投研对话与工具轨迹",
        "layer": "ADS",
        "desc_zh": "Copilot 会话轮次、FastMCP 调用轨迹、延迟与记忆命中档案",
        "date_col": "updated_at",
        "entity_col": "workspace_id",
        "sla_hours": None,
    },
    {
        "model": PaperTrade,
        "table": "paper_trades",
        "title_zh": "模拟盘决策与 Bracket 账本",
        "layer": "ADS",
        "desc_zh": "1% 预算钳位订单、HITL 审批流转及止盈止损状态",
        "date_col": "created_at",
        "entity_col": "symbol",
        "sla_hours": None,
    },
    {
        "model": TradeReview,
        "table": "trade_reviews",
        "title_zh": "T+N 交易归因复盘记录",
        "layer": "ADS",
        "desc_zh": "过程 × 结果四象限归因及相对 SPY 超额 Alpha 验证",
        "date_col": "created_at",
        "entity_col": None,
        "sla_hours": None,
    },
    {
        "model": WatchdogAlert,
        "table": "watchdog_alerts",
        "title_zh": "盘中哨兵异动与风控告警",
        "layer": "ADS",
        "desc_zh": "主动监测放量破位与跌破 Zero Gamma 去重告警流",
        "date_col": "created_at",
        "entity_col": "symbol",
        "sla_hours": None,
    },
    {
        "model": UserWatchlistItem,
        "table": "user_watchlist_items",
        "title_zh": "多租户自选股关注池",
        "layer": "ADS",
        "desc_zh": "按 workspace_id 隔离的用户关注列表与排序权重",
        "date_col": "created_at",
        "entity_col": "workspace_id",
        "sla_hours": None,
    },
    {
        "model": ImportedHolding,
        "table": "imported_holdings",
        "title_zh": "外部券商导入持仓快照",
        "layer": "ADS",
        "desc_zh": "IBKR / Trading212 / CSV 导入实盘或组合敞口映射",
        "date_col": "updated_at",
        "entity_col": "workspace_id",
        "sla_hours": None,
    },
    {
        "model": EvalRun,
        "table": "eval_runs",
        "title_zh": "四轨全栈评测历史基线库",
        "layer": "ADS",
        "desc_zh": "保存 Track 1~4 评测流水、pass^k 稳定性与回归 Baseline Diff 快照",
        "date_col": "created_at",
        "entity_col": "run_key",
        "sla_hours": None,
    },
)

_MONITORED_CACHES: tuple[dict[str, Any], ...] = (
    {
        "key": "marketelite:dashboard:overview",
        "label_zh": "主页宏观/Regime 总览快照",
        "domain": "overview",
        "hard_ttl_s": 86400,
    },
    {
        "key": DISCOVER_CACHE_KEY,
        "label_zh": "Discover 21条中译财经要闻池",
        "domain": "news",
        "hard_ttl_s": 7200,
    },
    {
        "key": "marketelite:onchain:pulse:v1",
        "label_zh": "链上活水与加密永续脉搏",
        "domain": "onchain",
        "hard_ttl_s": 172800,
    },
    {
        "key": "marketelite:moc:proxy:SPY:v1",
        "label_zh": "MOC 尾盘 15m 代理指标 (SPY)",
        "domain": "moc",
        "hard_ttl_s": 172800,
    },
    {
        "key": "marketelite:finra:ats_weekly:SPY:v1",
        "label_zh": "FINRA 周度 ATS 暗池汇总 (SPY)",
        "domain": "finra",
        "hard_ttl_s": 604800,
    },
)

_MONITORED_PROVIDERS: tuple[dict[str, str], ...] = (
    {"id": "alpaca", "name": "Alpaca Market & Paper", "domain": "美股行情/模拟盘", "auth": "API Key"},
    {"id": "alpaca_options_snap", "name": "Alpaca Indicative Options", "domain": "期权希腊字母", "auth": "API Key"},
    {"id": "fred", "name": "FRED Macro Series", "domain": "央行流动性/利差", "auth": "API Key"},
    {"id": "finnhub", "name": "Finnhub Earnings", "domain": "美股财报与EPS", "auth": "Free Key"},
    {"id": "fmp", "name": "FMP Calendar", "domain": "经济日程", "auth": "Free Key"},
    {"id": "yahoo_finance", "name": "Yahoo Finance Intraday", "domain": "全时段分时与利率", "auth": "免 Key"},
    {"id": "moc_proxy", "name": "Yahoo 15m MOC Proxy", "domain": "尾盘竞价代理", "auth": "免 Key"},
    {"id": "finra_ats", "name": "FINRA TRF & ATS", "domain": "暗池/场外做空", "auth": "免 Key"},
    {"id": "defillama_stablecoins", "name": "DefiLlama Stablecoins", "domain": "稳定币弹药", "auth": "免 Key"},
    {"id": "coinmetrics_btc", "name": "Coin Metrics Community", "domain": "BTC 充提与 MVRV", "auth": "免 Key"},
    {"id": "binance_premium", "name": "Binance Public Futures", "domain": "永续费率与 OI", "auth": "免 Key"},
    {"id": "cnn_fear_greed", "name": "CNN Fear & Greed", "domain": "市场情绪指数", "auth": "免 Key"},
    {"id": "cftc", "name": "CFTC Socrata COT", "domain": "聪明钱持仓周报", "auth": "免 Key"},
    {"id": "sec_edgar", "name": "SEC EDGAR Filings", "domain": "10-K/10-Q 财报", "auth": "User-Agent"},
)


def _to_iso(val: Any) -> str | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        dt = val if val.tzinfo is not None else val.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    if isinstance(val, date):
        return val.isoformat()
    return str(val)


def _hours_since(val: Any, now_utc: datetime) -> float | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        dt = val if val.tzinfo is not None else val.replace(tzinfo=timezone.utc)
        return round(max(0.0, (now_utc - dt).total_seconds() / 3600.0), 1)
    if isinstance(val, date):
        dt = datetime(val.year, val.month, val.day, 21, 0, tzinfo=timezone.utc)
        return round(max(0.0, (now_utc - dt).total_seconds() / 3600.0), 1)
    return None


async def build_data_catalog(
    session: AsyncSession,
    *,
    now_utc: datetime | None = None,
) -> list[dict[str, Any]]:
    """Query live row counts, entity coverage, min/max timestamps & SLA state across all 15 PG tables."""
    ref_now = now_utc or datetime.now(timezone.utc)
    rows_out: list[dict[str, Any]] = []

    for entry in _TABLE_REGISTRY:
        model = entry["model"]
        table_name = entry["table"]
        date_attr = getattr(model, entry["date_col"], None)
        entity_attr = getattr(model, entry["entity_col"], None) if entry["entity_col"] else None

        try:
            cols: list[Any] = [func.count().label("row_count")]
            if entity_attr is not None:
                cols.append(func.count(func.distinct(entity_attr)).label("distinct_entities"))
            if date_attr is not None:
                cols.append(func.min(date_attr).label("min_dt"))
                cols.append(func.max(date_attr).label("max_dt"))

            res = (await session.execute(select(*cols))).mappings().one()
            row_count = int(res["row_count"] or 0)
            distinct_cnt = int(res.get("distinct_entities") or 0) if entity_attr is not None else None
            min_dt = res.get("min_dt")
            max_dt = res.get("max_dt")
            lag_hours = _hours_since(max_dt, ref_now) if row_count > 0 else None

            sla_h = entry["sla_hours"]
            if row_count == 0:
                sla_status = "empty"
            elif sla_h is None or lag_hours is None:
                sla_status = "healthy"
            elif lag_hours <= sla_h:
                sla_status = "healthy"
            elif lag_hours <= sla_h * 2:
                sla_status = "warn"
            else:
                sla_status = "stale"

            rows_out.append(
                {
                    "table": table_name,
                    "title_zh": entry["title_zh"],
                    "layer": entry["layer"],
                    "desc_zh": entry["desc_zh"],
                    "row_count": row_count,
                    "distinct_entities": distinct_cnt,
                    "min_ts": _to_iso(min_dt),
                    "max_ts": _to_iso(max_dt),
                    "lag_hours": lag_hours,
                    "sla_hours": sla_h,
                    "sla_status": sla_status,
                }
            )
        except SQLAlchemyError as exc:
            logger.debug("Catalog inspect fallback on %s: %s", table_name, exc)
            rows_out.append(
                {
                    "table": table_name,
                    "title_zh": entry["title_zh"],
                    "layer": entry["layer"],
                    "desc_zh": entry["desc_zh"],
                    "row_count": 0,
                    "distinct_entities": None,
                    "min_ts": None,
                    "max_ts": None,
                    "lag_hours": None,
                    "sla_hours": entry["sla_hours"],
                    "sla_status": "error",
                }
            )

    return rows_out


async def inspect_redis_and_circuits(
    redis_client: aioredis.Redis | None,
    settings: Settings,
    *,
    now_epoch: float | None = None,
) -> dict[str, Any]:
    """Inspect Redis key namespaces, DualTTLCache envelope freshness & per-provider circuit breakers."""
    now_s = now_epoch if now_epoch is not None else time.time()
    prefix_counts: Counter[str] = Counter()
    total_keys = 0
    used_memory_human = None

    if redis_client is not None:
        try:
            if hasattr(redis_client, "scan_iter"):
                scanned = 0
                async for key in redis_client.scan_iter(match="marketelite:*", count=250):
                    scanned += 1
                    parts = str(key).split(":")
                    bucket = ":".join(parts[:2]) if len(parts) >= 2 else str(key)
                    prefix_counts[bucket] += 1
                    if scanned >= 5000:
                        break
                total_keys = int(await redis_client.dbsize()) if hasattr(redis_client, "dbsize") else scanned
            elif hasattr(redis_client, "keys"):
                keys = await redis_client.keys("marketelite:*")
                total_keys = len(keys)
                for key in keys:
                    parts = str(key).split(":")
                    bucket = ":".join(parts[:2]) if len(parts) >= 2 else str(key)
                    prefix_counts[bucket] += 1
            if hasattr(redis_client, "info"):
                mem = await redis_client.info("memory")
                used_memory_human = mem.get("used_memory_human")
        except (RedisError, OSError, RuntimeError, TypeError) as exc:
            logger.debug("Redis namespace inspect skipped cleanly: %s", exc)

    envelopes: list[dict[str, Any]] = []
    fresh_count = 0
    stale_count = 0
    for spec in _MONITORED_CACHES:
        item: dict[str, Any] = {
            "key": spec["key"],
            "label_zh": spec["label_zh"],
            "domain": spec["domain"],
            "status": "empty",
            "fetched_at": None,
            "age_minutes": None,
            "soft_ttl_remaining_s": None,
            "source": None,
        }
        if redis_client is not None:
            try:
                raw = await redis_client.get(spec["key"])
                if raw:
                    env = json.loads(raw) if isinstance(raw, str) else raw
                    if isinstance(env, dict):
                        soft_exp = float(env.get("soft_expires_at") or 0.0)
                        fetched_at = str(env.get("fetched_at") or "")
                        age_min = None
                        if fetched_at:
                            try:
                                dt = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
                                age_min = round(max(0.0, (now_s - dt.timestamp()) / 60.0), 1)
                            except ValueError:
                                pass
                        rem_s = round(soft_exp - now_s, 0)
                        is_fresh = rem_s > 0
                        if is_fresh:
                            fresh_count += 1
                        else:
                            stale_count += 1
                        item.update(
                            {
                                "status": "fresh" if is_fresh else "stale_grace",
                                "fetched_at": fetched_at or None,
                                "age_minutes": age_min,
                                "soft_ttl_remaining_s": int(rem_s),
                                "source": env.get("source"),
                            }
                        )
            except (RedisError, json.JSONDecodeError, ValueError, TypeError):
                pass
        envelopes.append(item)

    readiness_map = {r["id"]: r for r in settings.integration_readiness()}
    providers: list[dict[str, Any]] = []
    open_breakers = 0

    for meta in _MONITORED_PROVIDERS:
        pid = meta["id"]
        cb_state = "closed"
        failures = 0
        cooldown_ttl_s: int | None = None
        if redis_client is not None:
            try:
                state_val = await redis_client.get(f"marketelite:cb:{pid}:state")
                fail_val = await redis_client.get(f"marketelite:cb:{pid}:failures")
                if state_val == "open":
                    cb_state = "open"
                    open_breakers += 1
                    if hasattr(redis_client, "ttl"):
                        ttl_res = await redis_client.ttl(f"marketelite:cb:{pid}:state")
                        if isinstance(ttl_res, int) and ttl_res >= 0:
                            cooldown_ttl_s = ttl_res
                if fail_val is not None:
                    failures = int(fail_val)
            except (RedisError, ValueError, TypeError):
                pass

        # Map sub-providers to integration config readiness where applicable
        base_id = (
            "alpaca"
            if pid.startswith("alpaca")
            else "yahoo"
            if pid.startswith("yahoo") or pid == "moc_proxy"
            else "binance"
            if pid.startswith("binance")
            else pid
        )
        cfg_meta = readiness_map.get(base_id)
        configured = bool(cfg_meta["configured"]) if cfg_meta is not None else True

        providers.append(
            {
                "id": pid,
                "name": meta["name"],
                "domain": meta["domain"],
                "auth_mode": meta["auth"],
                "configured": configured,
                "circuit_state": cb_state,
                "recent_failures": failures,
                "cooldown_remaining_s": cooldown_ttl_s,
            }
        )

    return {
        "total_keys": total_keys,
        "used_memory_human": used_memory_human or "N/A",
        "namespace_counts": [
            {"prefix": k, "count": v}
            for k, v in sorted(prefix_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:12]
        ],
        "envelopes": envelopes,
        "fresh_envelopes": fresh_count,
        "stale_envelopes": stale_count,
        "providers": providers,
        "open_circuit_breakers": open_breakers,
    }


async def run_data_quality_audit(
    session: AsyncSession,
    redis_client: aioredis.Redis | None,
    *,
    now_utc: datetime | None = None,
) -> dict[str, Any]:
    """Execute 6 deterministic financial Data Quality (DQ) checks across PG & Redis."""
    ref_now = now_utc or datetime.now(timezone.utc)
    checks: list[dict[str, Any]] = []

    # DQ-01: MarketDailyBar integrity & zero/negative anomaly check
    try:
        core_syms = ("SPY", "QQQ", "SOXX", "NVDA", "AAPL")
        total_bars = int((await session.scalar(select(func.count()).select_from(MarketDailyBar))) or 0)
        bad_bars = int(
            (
                await session.scalar(
                    select(func.count())
                    .select_from(MarketDailyBar)
                    .where((MarketDailyBar.close <= 0) | (MarketDailyBar.open <= 0) | (MarketDailyBar.volume < 0))
                )
            )
            or 0
        )
        core_counts = {
            row[0]: int(row[1])
            for row in (
                await session.execute(
                    select(MarketDailyBar.symbol, func.count())
                    .where(MarketDailyBar.symbol.in_(core_syms))
                    .group_by(MarketDailyBar.symbol)
                )
            ).all()
        }
        missing_core = [s for s in core_syms if core_counts.get(s, 0) < 20]
        if total_bars == 0:
            dq1 = {"status": "warn", "detail_zh": "行情日线库为空，请先触发管道同步或重启预热", "affected": list(core_syms)}
        elif bad_bars > 0 or missing_core:
            dq1 = {
                "status": "fail" if bad_bars > 0 else "warn",
                "detail_zh": f"异常脏柱 {bad_bars} 条 · 历史不足20日标的: {', '.join(missing_core) or '无'}",
                "affected": missing_core,
            }
        else:
            dq1 = {"status": "pass", "detail_zh": f"全库 {total_bars:,} 条日线 OHLCV 数值完整，5大核心标的历史 >=20日", "affected": []}
    except SQLAlchemyError as exc:
        dq1 = {"status": "warn", "detail_zh": f"检查跳过: {exc}", "affected": []}
    checks.append({"id": "DQ-01", "name_zh": "行情日线完整性与极值防错", "table": "market_daily_bars", **dq1})

    # DQ-02: MacroSeries freshness & required FRED core coverage
    try:
        req_series = ("WALCL", "WTREGEN", "RRPONTSYD", "DGS10", "DGS2")
        latest_by_series = {
            row[0]: row[1]
            for row in (
                await session.execute(
                    select(MacroSeriesPoint.series_id, func.max(MacroSeriesPoint.obs_date)).group_by(
                        MacroSeriesPoint.series_id
                    )
                )
            ).all()
        }
        missing_macro = [s for s in req_series if s not in latest_by_series]
        stale_macro = [
            f"{s}({d.isoformat()})"
            for s, d in latest_by_series.items()
            if s in req_series and d is not None and (ref_now.date() - d).days > 21
        ]
        if not latest_by_series:
            dq2 = {"status": "warn", "detail_zh": "宏观流动性库为空（WALCL/TGA/RRP 暂未入库）", "affected": list(req_series)}
        elif missing_macro or stale_macro:
            dq2 = {
                "status": "warn",
                "detail_zh": f"缺失序列: {missing_macro or '无'} · 超21日未更新: {stale_macro or '无'}",
                "affected": missing_macro + stale_macro,
            }
        else:
            dq2 = {"status": "pass", "detail_zh": f"已覆全核心 FRED/宏观 {len(latest_by_series)} 条序列，无断更缺口", "affected": []}
    except SQLAlchemyError as exc:
        dq2 = {"status": "warn", "detail_zh": f"检查跳过: {exc}", "affected": []}
    checks.append({"id": "DQ-02", "name_zh": "宏观水库与利率时序连续性", "table": "macro_series", **dq2})

    # DQ-03: Options GEX snapshot validity
    try:
        gex_cnt = int((await session.scalar(select(func.count()).select_from(OptionsGexSnapshot))) or 0)
        bad_gex = int(
            (
                await session.scalar(
                    select(func.count())
                    .select_from(OptionsGexSnapshot)
                    .where((OptionsGexSnapshot.spot_price <= 0) | (OptionsGexSnapshot.contracts_analyzed <= 0))
                )
            )
            or 0
        )
        null_zg = int(
            (
                await session.scalar(
                    select(func.count())
                    .select_from(OptionsGexSnapshot)
                    .where(OptionsGexSnapshot.zero_gamma.is_(None))
                )
            )
            or 0
        )
        if gex_cnt == 0:
            dq3 = {"status": "warn", "detail_zh": "期权 GEX 快照表尚无记录", "affected": []}
        elif bad_gex > 0:
            dq3 = {"status": "fail", "detail_zh": f"发现 {bad_gex} 条异常期权快照 (spot<=0 或无合约)", "affected": []}
        elif null_zg > gex_cnt * 0.5:
            dq3 = {"status": "warn", "detail_zh": f"{null_zg}/{gex_cnt} 条快照缺少 Zero Gamma 翻转位", "affected": []}
        else:
            dq3 = {"status": "pass", "detail_zh": f"共 {gex_cnt} 份 GEX 快照有效，Spot/合约/Gamma墙均合规", "affected": []}
    except SQLAlchemyError as exc:
        dq3 = {"status": "warn", "detail_zh": f"检查跳过: {exc}", "affected": []}
    checks.append({"id": "DQ-03", "name_zh": "期权链 GEX 与关键墙位结构检查", "table": "options_gex_snapshots", **dq3})

    # DQ-04: Discover 21 News translation completeness & count check
    dq4 = {"status": "warn", "detail_zh": "Discover 资讯缓存暂未就绪", "affected": []}
    if redis_client is not None:
        try:
            raw_disc = await redis_client.get(DISCOVER_CACHE_KEY)
            if raw_disc:
                env = json.loads(raw_disc) if isinstance(raw_disc, str) else raw_disc
                items = ((env.get("payload") or {}).get("items") or []) if isinstance(env, dict) else []
                cnt = len(items)
                zh_ok = sum(1 for it in items if _CJK_RE.search(str(it.get("title_zh") or "")))
                if cnt == 0:
                    dq4 = {"status": "warn", "detail_zh": "Discover 资讯列表为空", "affected": []}
                elif cnt < 21 or zh_ok < cnt:
                    untrans = [str(it.get("source") or "news") for it in items if not _CJK_RE.search(str(it.get("title_zh") or ""))]
                    dq4 = {
                        "status": "warn",
                        "detail_zh": f"当前 {cnt}/21 条要闻，其中 {zh_ok}/{cnt} 条含中文直译标题",
                        "affected": untrans[:5],
                    }
                else:
                    dq4 = {"status": "pass", "detail_zh": f"已满载 {cnt}/21 条要闻，100% 含中文直译标题 ({zh_ok}/{cnt})", "affected": []}
        except (RedisError, json.JSONDecodeError, TypeError):
            pass
    checks.append({"id": "DQ-04", "name_zh": "Discover 21 条新闻满载与中译完整率", "table": DISCOVER_CACHE_KEY, **dq4})

    # DQ-05: Multi-tenant workspace_id isolation audit
    try:
        tenant_tables = (
            ("paper_trades", PaperTrade),
            ("user_watchlist_items", UserWatchlistItem),
            ("investigator_threads", InvestigatorThread),
            ("watchdog_alerts", WatchdogAlert),
            ("episodic_memories", EpisodicMemory),
            ("imported_holdings", ImportedHolding),
        )
        orphan_hits: list[str] = []
        for tname, model in tenant_tables:
            bad_ws = int(
                (
                    await session.scalar(
                        select(func.count())
                        .select_from(model)
                        .where((model.workspace_id.is_(None)) | (model.workspace_id == ""))
                    )
                )
                or 0
            )
            if bad_ws > 0:
                orphan_hits.append(f"{tname}({bad_ws})")
        if orphan_hits:
            dq5 = {"status": "fail", "detail_zh": f"发现未打 workspace_id 的隔离越界风险行: {', '.join(orphan_hits)}", "affected": orphan_hits}
        else:
            dq5 = {"status": "pass", "detail_zh": "6 大用户业务表 workspace_id 多租户隔离键 100% 完整", "affected": []}
    except SQLAlchemyError as exc:
        dq5 = {"status": "warn", "detail_zh": f"检查跳过: {exc}", "affected": []}
    checks.append({"id": "DQ-05", "name_zh": "多租户工作区隔离键合规审计", "table": "workspace_scoped_tables", **dq5})

    # DQ-06: Microstructure (On-Chain / MOC / FINRA) live cache health
    dq6_issues: list[str] = []
    dq6_ready = 0
    if redis_client is not None:
        try:
            raw_oc = await redis_client.get("marketelite:onchain:pulse:v1")
            if raw_oc:
                dq6_ready += 1
                oc_p = ((json.loads(raw_oc) if isinstance(raw_oc, str) else raw_oc).get("payload") or {})
                deg = oc_p.get("degraded_sources") or []
                if deg:
                    dq6_issues.append(f"链上局部降级: {','.join(deg)}")
            if await redis_client.get("marketelite:moc:proxy:SPY:v1"):
                dq6_ready += 1
            if await redis_client.get("marketelite:finra:ats_weekly:SPY:v1"):
                dq6_ready += 1
        except (RedisError, json.JSONDecodeError, TypeError):
            pass
    if dq6_issues:
        dq6 = {"status": "warn", "detail_zh": " · ".join(dq6_issues), "affected": dq6_issues}
    elif dq6_ready >= 2:
        dq6 = {"status": "pass", "detail_zh": f"微结构 {dq6_ready}/3 路核心缓存热就绪且无降级源", "affected": []}
    else:
        dq6 = {"status": "warn", "detail_zh": f"微结构缓存按需懒加载中（已预热 {dq6_ready}/3 路，访问首页即拉满）", "affected": []}
    checks.append({"id": "DQ-06", "name_zh": "MOC/暗池/链上微结构源健康探针", "table": "redis_microstructure", **dq6})

    total = len(checks)
    passed = sum(1 for c in checks if c["status"] == "pass")
    warns = sum(1 for c in checks if c["status"] == "warn")
    fails = sum(1 for c in checks if c["status"] == "fail")
    score = round(((passed * 1.0 + warns * 0.55) / max(1, total)) * 100.0, 1)

    return {
        "checked_at": ref_now.isoformat(),
        "health_score": score,
        "summary": {"total": total, "pass": passed, "warn": warns, "fail": fails},
        "checks": checks,
    }


def build_lineage_graph(
    *,
    catalog: list[dict[str, Any]],
    cache_snapshot: dict[str, Any],
    settings: Settings,
) -> dict[str, Any]:
    """Assemble live 4-layer Medallion Data Lineage (ODS -> DWD -> DWS -> ADS) with status mapping."""
    cat_by_table = {r["table"]: r for r in catalog}
    prov_by_id = {p["id"]: p for p in cache_snapshot.get("providers", [])}
    env_by_domain = {e["domain"]: e for e in cache_snapshot.get("envelopes", [])}

    def _prov_status(pid: str) -> str:
        p = prov_by_id.get(pid)
        if not p:
            return "unknown"
        if not p["configured"]:
            return "unconfigured"
        if p["circuit_state"] == "open":
            return "circuit_open"
        return "healthy"

    def _table_status(tname: str) -> tuple[str, str]:
        row = cat_by_table.get(tname)
        if not row:
            return "empty", "0 行"
        cnt = row["row_count"]
        st = row["sla_status"]
        mapped = "healthy" if st == "healthy" else ("warn" if st in {"warn", "empty"} else "degraded")
        return mapped, f"{cnt:,} 行"

    def _env_status(domain: str) -> tuple[str, str]:
        env = env_by_domain.get(domain)
        if not env or env["status"] == "empty":
            return "warn", "未预热"
        if env["status"] == "fresh":
            return "healthy", f"{env['age_minutes']}m前"
        return "warn", f"旧缓存 {env['age_minutes']}m"

    nodes: list[dict[str, Any]] = [
        # ODS Sources
        {"id": "ods_alpaca", "layer": "ods", "label": "Alpaca SIP & 期权链", "sub": "日线/Indicative Greeks/Paper", "status": _prov_status("alpaca"), "metric": "Configured" if settings.alpaca_api_key else "未配Key"},
        {"id": "ods_fred", "layer": "ods", "label": "FRED + CBOE + CFTC", "sub": "WALCL/TGA/RRP · VIX · COT", "status": _prov_status("fred"), "metric": "Macro Feed"},
        {"id": "ods_finra", "layer": "ods", "label": "FINRA TRF & ATS", "sub": "每日场外/做空 + 周报暗池", "status": _prov_status("finra_ats"), "metric": "免 Key"},
        {"id": "ods_onchain", "layer": "ods", "label": "DefiLlama · CM · Binance", "sub": "稳定币 · BTC净流/MVRV · 永续", "status": _prov_status("defillama_stablecoins"), "metric": "免 Key 3路"},
        {"id": "ods_sec", "layer": "ods", "label": "SEC EDGAR Filings", "sub": "10-K / 10-Q / 8-K 原文", "status": _prov_status("sec_edgar"), "metric": "EDGAR API"},
        {"id": "ods_yahoo", "layer": "ods", "label": "Yahoo · CNN · Finnhub", "sub": "分时/MOC 15m/情绪/21新闻", "status": _prov_status("yahoo_finance"), "metric": "Live Feeds"},
        # DWD Cleaned / Cache Layer
        {"id": "dwd_bars", "layer": "dwd", "label": "market_daily_bars + macro", "sub": "NY时区对齐 · 复权 · 去极值", "status": _table_status("market_daily_bars")[0], "metric": _table_status("market_daily_bars")[1]},
        {"id": "dwd_cache", "layer": "dwd", "label": "Redis DualTTLCache + 熔断", "sub": f"{cache_snapshot.get('total_keys', 0)} Keys · {cache_snapshot.get('open_circuit_breakers', 0)} 熔断", "status": "degraded" if cache_snapshot.get("open_circuit_breakers", 0) > 0 else "healthy", "metric": f"{cache_snapshot.get('fresh_envelopes', 0)} Fresh"},
        {"id": "dwd_news", "layer": "dwd", "label": "Discover 21要闻清洗译文", "sub": "去重聚类 + 免Key NMT 自愈", "status": _env_status("news")[0], "metric": _env_status("news")[1]},
        {"id": "dwd_micro", "layer": "dwd", "label": "MOC代理 / TRF / 链上聚合", "sub": "15:45冲量 · Z-Score · MVRV", "status": _env_status("onchain")[0], "metric": _env_status("onchain")[1]},
        # DWS Feature Store & Vector Corpus
        {"id": "dws_regime", "layer": "dws", "label": "Regime & GEX 特征快照", "sub": "market_regime_daily · options_gex", "status": _table_status("market_regime_daily")[0], "metric": _table_status("market_regime_daily")[1]},
        {"id": "dws_sec_rag", "layer": "dws", "label": "SEC 混合向量切片库", "sub": "pgvector(1536) + GIN BM25", "status": _table_status("sec_filing_chunks")[0], "metric": _table_status("sec_filing_chunks")[1]},
        {"id": "dws_memory", "layer": "dws", "label": "Episodic Memory 错题库", "sub": "T+N 归因经验 & Playbook 规则", "status": _table_status("episodic_memories")[0], "metric": _table_status("episodic_memories")[1]},
        # ADS Serving & Agents
        {"id": "ads_cockpit", "layer": "ads", "label": "MarketElite 14大Bento看板", "sub": "大盘 · 期权雷达 · 21要闻 · MOC/暗池/链上", "status": "healthy", "metric": "14 Widgets"},
        {"id": "ads_mcp", "layer": "ads", "label": "FastMCP 8大只读工具服务", "sub": "Token预算截断 + 结构化JSON", "status": "healthy", "metric": "8 Tools"},
        {"id": "ads_agents", "layer": "ads", "label": "Investigator · Critic · Watchdog", "sub": "ReAct多步 + HITL强拦截 + Phoenix追踪", "status": "healthy", "metric": _table_status("investigator_threads")[1]},
    ]

    edges: list[dict[str, str]] = [
        {"from": "ods_alpaca", "to": "dwd_bars"},
        {"from": "ods_alpaca", "to": "dws_regime"},
        {"from": "ods_fred", "to": "dwd_bars"},
        {"from": "ods_fred", "to": "dws_regime"},
        {"from": "ods_yahoo", "to": "dwd_cache"},
        {"from": "ods_yahoo", "to": "dwd_news"},
        {"from": "ods_yahoo", "to": "dwd_micro"},
        {"from": "ods_finra", "to": "dwd_cache"},
        {"from": "ods_finra", "to": "dwd_micro"},
        {"from": "ods_onchain", "to": "dwd_cache"},
        {"from": "ods_onchain", "to": "dwd_micro"},
        {"from": "ods_sec", "to": "dws_sec_rag"},
        {"from": "dwd_bars", "to": "dws_regime"},
        {"from": "dwd_cache", "to": "ads_cockpit"},
        {"from": "dwd_news", "to": "ads_cockpit"},
        {"from": "dwd_micro", "to": "ads_cockpit"},
        {"from": "dws_regime", "to": "ads_cockpit"},
        {"from": "dws_regime", "to": "ads_mcp"},
        {"from": "dws_sec_rag", "to": "ads_mcp"},
        {"from": "dws_memory", "to": "ads_mcp"},
        {"from": "ads_mcp", "to": "ads_agents"},
        {"from": "dws_memory", "to": "ads_agents"},
    ]

    return {"nodes": nodes, "edges": edges}


async def inspect_rag_and_memory(session: AsyncSession) -> dict[str, Any]:
    """Aggregate SEC 10-K/10-Q chunk/embedding coverage and EpisodicMemory distribution."""
    filings: list[dict[str, Any]] = []
    total_chunks = 0
    embedded_chunks = 0
    sec_sections: list[dict[str, Any]] = []

    try:
        doc_rows = (
            await session.execute(
                select(SecFilingDocument).order_by(SecFilingDocument.filing_date.desc()).limit(30)
            )
        ).scalars().all()
        chunk_stats = {
            row[0]: {"chunks": int(row[1] or 0), "embedded": int(row[2] or 0), "avg_tok": int(row[3] or 0)}
            for row in (
                await session.execute(
                    select(
                        SecFilingChunk.filing_id,
                        func.count(),
                        func.count(SecFilingChunk.embedding),
                        func.avg(SecFilingChunk.token_estimate),
                    ).group_by(SecFilingChunk.filing_id)
                )
            ).all()
        }
        for d in doc_rows:
            st = chunk_stats.get(d.id, {"chunks": d.chunk_count, "embedded": 0, "avg_tok": 0})
            tot = max(int(d.chunk_count), st["chunks"])
            emb = st["embedded"]
            total_chunks += tot
            embedded_chunks += emb
            filings.append(
                {
                    "id": d.id,
                    "symbol": d.symbol,
                    "form_type": d.form_type,
                    "filing_date": d.filing_date.isoformat(),
                    "chunk_count": tot,
                    "embedded_count": emb,
                    "embedding_pct": round((emb / tot) * 100.0, 1) if tot > 0 else 0.0,
                    "avg_tokens": st["avg_tok"],
                    "ingested_at": d.ingested_at.isoformat(),
                }
            )

        sec_rows = (
            await session.execute(
                select(SecFilingChunk.section_title, func.count())
                .group_by(SecFilingChunk.section_title)
                .order_by(func.count().desc())
                .limit(8)
            )
        ).all()
        sec_sections = [{"section": str(r[0]), "count": int(r[1])} for r in sec_rows]
    except SQLAlchemyError as exc:
        logger.debug("SEC corpus inspection skipped cleanly: %s", exc)

    memory_stats: dict[str, Any] = {
        "total": 0,
        "active": 0,
        "pinned": 0,
        "embedded": 0,
        "quadrants": [],
        "recent": [],
    }
    try:
        m_rows = (
            await session.execute(
                select(EpisodicMemory).order_by(EpisodicMemory.created_at.desc()).limit(100)
            )
        ).scalars().all()
        quad_cnt: Counter[str] = Counter()
        for m in m_rows:
            quad_cnt[m.quadrant_outcome] += 1
        memory_stats = {
            "total": len(m_rows),
            "active": sum(1 for m in m_rows if m.is_active),
            "pinned": sum(1 for m in m_rows if m.is_pinned),
            "embedded": sum(1 for m in m_rows if m.embedding is not None),
            "quadrants": [{"quadrant": k, "count": v} for k, v in quad_cnt.items()],
            "recent": [
                {
                    "id": m.id,
                    "symbol": m.symbol,
                    "regime_label": m.regime_label,
                    "quadrant_outcome": m.quadrant_outcome,
                    "title": m.title,
                    "is_pinned": m.is_pinned,
                    "is_active": m.is_active,
                    "alpha_vs_spy_pct": m.alpha_vs_spy_pct,
                }
                for m in m_rows[:8]
            ],
        }
    except SQLAlchemyError as exc:
        logger.debug("Episodic memory inspection skipped cleanly: %s", exc)

    return {
        "sec_corpus": {
            "total_filings": len(filings),
            "total_chunks": total_chunks,
            "embedded_chunks": embedded_chunks,
            "embedding_coverage_pct": round((embedded_chunks / total_chunks) * 100.0, 1)
            if total_chunks > 0
            else 0.0,
            "filings": filings,
            "top_sections": sec_sections,
        },
        "episodic_memory": memory_stats,
    }


async def debug_hybrid_rag_search(
    session_factory: async_sessionmaker[AsyncSession],
    settings: Settings,
    *,
    symbol: str,
    query: str,
    form_type: str | None = None,
    top_k: int = 5,
    allow_ingest: bool = False,
) -> dict[str, Any]:
    """Run live HybridSecRetriever query and expose per-chunk vector/BM25/RRF scores for debugging."""
    t0 = time.perf_counter()
    retriever = HybridSecRetriever(settings, session_factory)
    res = await retriever.search(
        symbol.upper().strip(),
        query.strip(),
        form_type=form_type.upper().strip() if form_type else None,
        top_k=max(1, min(10, top_k)),
        auto_ingest=allow_ingest,
    )
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    return {
        "status": "ok",
        "elapsed_ms": elapsed_ms,
        **res,
    }


async def build_finops_telemetry(
    session: AsyncSession,
    settings: Settings,
    cache_snapshot: dict[str, Any],
) -> dict[str, Any]:
    """Summarize Investigator thread traces, duplicate-guard saves, tool latencies & LLM routing."""
    threads: list[InvestigatorThread] = []
    try:
        threads = list(
            (
                await session.execute(
                    select(InvestigatorThread).order_by(InvestigatorThread.updated_at.desc()).limit(50)
                )
            )
            .scalars()
            .all()
        )
    except SQLAlchemyError as exc:
        logger.debug("InvestigatorThread telemetry skipped cleanly: %s", exc)

    total_calls = 0
    blocked_duplicates = 0
    tool_latencies: dict[str, list[float]] = {}
    tool_errors: Counter[str] = Counter()

    for th in threads:
        for tr in th.tool_traces_json or []:
            if not isinstance(tr, dict):
                continue
            tname = str(tr.get("tool") or tr.get("name") or "unknown")
            st = str(tr.get("status") or "ok")
            total_calls += 1
            if st == "blocked_duplicate":
                blocked_duplicates += 1
            elif st == "error":
                tool_errors[tname] += 1
            lat = tr.get("latency_ms")
            if isinstance(lat, (int, float)) and lat >= 0:
                tool_latencies.setdefault(tname, []).append(float(lat))

    per_tool: list[dict[str, Any]] = []
    for tname, lats in sorted(tool_latencies.items(), key=lambda kv: -len(kv[1])):
        sorted_l = sorted(lats)
        p95_idx = min(len(sorted_l) - 1, max(0, int(len(sorted_l) * 0.95) - 1))
        per_tool.append(
            {
                "tool": tname,
                "calls": len(sorted_l),
                "errors": int(tool_errors.get(tname, 0)),
                "avg_ms": round(sum(sorted_l) / len(sorted_l), 1),
                "p95_ms": round(sorted_l[p95_idx], 1),
            }
        )

    return {
        "llm_routing": {
            "fast_model": settings.llm_fast_model,
            "fast_configured": bool(settings.llm_fast_api_key.strip()),
            "pro_model": settings.llm_pro_model,
            "pro_configured": bool(settings.llm_pro_api_key.strip()),
            "embedding_model": settings.llm_embedding_model,
            "embedding_dim": settings.llm_embedding_dim,
            "max_steps_guard": settings.agent_max_steps,
            "wall_timeout_s": settings.agent_wall_timeout_seconds,
            "max_context_tokens": settings.agent_max_context_tokens,
        },
        "agent_runtime": {
            "recent_threads_sampled": len(threads),
            "total_tool_calls": total_calls,
            "avg_tools_per_thread": round(total_calls / len(threads), 2) if threads else 0.0,
            "blocked_duplicate_loops": blocked_duplicates,
            "per_tool_latency": per_tool,
        },
        "cache_efficiency": {
            "redis_keys": cache_snapshot.get("total_keys", 0),
            "redis_memory": cache_snapshot.get("used_memory_human", "N/A"),
            "fresh_envelopes": cache_snapshot.get("fresh_envelopes", 0),
            "stale_grace_envelopes": cache_snapshot.get("stale_envelopes", 0),
        },
    }
