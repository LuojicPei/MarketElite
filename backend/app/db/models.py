from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    Computed,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utc_now() -> datetime:
    """Return timezone-aware UTC timestamp."""
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    """Base SQLAlchemy declarative class for MarketElite."""


class MarketDailyBar(Base):
    """Historical daily OHLCV bars for equities, sector ETFs, macro proxies, and BTC."""

    __tablename__ = "market_daily_bars"
    __table_args__ = (
        UniqueConstraint("symbol", "trade_date", name="uq_market_daily_bars_symbol_date"),
        Index("ix_market_daily_bars_symbol_date_desc", "symbol", "trade_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    asset_class: Mapped[str] = mapped_column(String(24), nullable=False, default="equity")
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    open: Mapped[float] = mapped_column(Float, nullable=False)
    high: Mapped[float] = mapped_column(Float, nullable=False)
    low: Mapped[float] = mapped_column(Float, nullable=False)
    close: Mapped[float] = mapped_column(Float, nullable=False)
    volume: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    vwap: Mapped[float | None] = mapped_column(Float, nullable=True)
    trade_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="alpaca")
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class MacroSeriesPoint(Base):
    """Daily/weekly macro, yield curve, credit spread, and VIX term-structure observations."""

    __tablename__ = "macro_series"
    __table_args__ = (
        UniqueConstraint("series_id", "obs_date", name="uq_macro_series_id_date"),
        Index("ix_macro_series_id_date", "series_id", "obs_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    series_id: Mapped[str] = mapped_column(String(48), nullable=False)
    obs_date: Mapped[date] = mapped_column(Date, nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="fred")
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class OptionsGexSnapshot(Base):
    """Deterministic Estimated GEX snapshots joining Alpaca indicative Greeks with OCC OI."""

    __tablename__ = "options_gex_snapshots"
    __table_args__ = (Index("ix_options_gex_symbol_time", "symbol", "snapshot_time"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    snapshot_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    spot_price: Mapped[float] = mapped_column(Float, nullable=False)
    net_gex: Mapped[float] = mapped_column(Float, nullable=False)
    call_wall: Mapped[float | None] = mapped_column(Float, nullable=True)
    put_wall: Mapped[float | None] = mapped_column(Float, nullable=True)
    zero_gamma: Mapped[float | None] = mapped_column(Float, nullable=True)
    put_call_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    total_call_oi: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_put_oi: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    contracts_analyzed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    assumption_label: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        default="Estimated GEX (Dealer Positioning Assumption · OCC T+1/T+2 OI)",
    )
    strike_profile_json: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list
    )
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="alpaca_indicative")
    is_stale: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class MarketRegimeDaily(Base):
    """Daily deterministic market regime, liquidity, breadth, and Fear & Greed snapshot."""

    __tablename__ = "market_regime_daily"
    __table_args__ = (
        UniqueConstraint("regime_date", name="uq_market_regime_daily_date"),
        Index("ix_market_regime_daily_date", "regime_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    regime_date: Mapped[date] = mapped_column(Date, nullable=False)
    regime_label: Mapped[str] = mapped_column(String(48), nullable=False)
    net_liquidity_billions: Mapped[float | None] = mapped_column(Float, nullable=True)
    net_liquidity_delta_20d: Mapped[float | None] = mapped_column(Float, nullable=True)
    yield_spread_10y2y: Mapped[float | None] = mapped_column(Float, nullable=True)
    hy_oas: Mapped[float | None] = mapped_column(Float, nullable=True)
    hyg_lqd_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    vix_spot: Mapped[float | None] = mapped_column(Float, nullable=True)
    vix_3m: Mapped[float | None] = mapped_column(Float, nullable=True)
    vix_term_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    vix_structure_state: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fear_greed_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    fear_greed_label: Mapped[str | None] = mapped_column(String(32), nullable=True)
    fear_greed_components_json: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict
    )
    rsp_spy_ratio: Mapped[float | None] = mapped_column(Float, nullable=True)
    pct_above_50ma: Mapped[float | None] = mapped_column(Float, nullable=True)
    pct_above_200ma: Mapped[float | None] = mapped_column(Float, nullable=True)
    sector_rotation_json: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list
    )
    cross_asset_corr_json: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict
    )
    cot_positioning_json: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict
    )
    overview_payload_json: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict
    )
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class EconomicCalendarEvent(Base):
    """Macro economic releases (FMP) and corporate earnings events (Finnhub)."""

    __tablename__ = "economic_calendar"
    __table_args__ = (
        UniqueConstraint("event_key", name="uq_economic_calendar_event_key"),
        Index("ix_economic_calendar_time", "event_time"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_key: Mapped[str] = mapped_column(String(160), nullable=False)
    event_type: Mapped[str] = mapped_column(String(24), nullable=False, default="macro")
    event_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    symbol: Mapped[str | None] = mapped_column(String(24), nullable=True)
    country: Mapped[str] = mapped_column(String(16), nullable=False, default="US")
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    impact: Mapped[str] = mapped_column(String(24), nullable=False, default="Medium")
    actual: Mapped[float | None] = mapped_column(Float, nullable=True)
    estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    previous: Mapped[float | None] = mapped_column(Float, nullable=True)
    eps_actual: Mapped[float | None] = mapped_column(Float, nullable=True)
    eps_estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    revenue_estimate: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="fmp")
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class ConsensusEpsSnapshot(Base):
    """Daily persisted EPS consensus snapshots for tracking forward estimate revisions."""

    __tablename__ = "consensus_eps_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "symbol",
            "snapshot_date",
            "period",
            name="uq_consensus_eps_symbol_date_period",
        ),
        Index("ix_consensus_eps_symbol_date", "symbol", "snapshot_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    snapshot_date: Mapped[date] = mapped_column(Date, nullable=False)
    period: Mapped[str] = mapped_column(String(32), nullable=False)
    eps_avg: Mapped[float | None] = mapped_column(Float, nullable=True)
    eps_high: Mapped[float | None] = mapped_column(Float, nullable=True)
    eps_low: Mapped[float | None] = mapped_column(Float, nullable=True)
    number_analysts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="finnhub")
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class PaperTrade(Base):
    """Paper trading ledger persisted cleanly for Risk Critic HITL & Watchdog T+N reviews."""

    __tablename__ = "paper_trades"
    __table_args__ = (
        Index("ix_paper_trades_symbol_created", "symbol", "created_at"),
        Index("ix_paper_trades_thread_id", "thread_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    thread_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    side: Mapped[str] = mapped_column(String(12), nullable=False)
    order_class: Mapped[str] = mapped_column(String(24), nullable=False, default="bracket")
    qty: Mapped[float] = mapped_column(Float, nullable=False)
    entry_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    stop_loss_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    take_profit_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    risk_budget_pct: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    alpaca_order_id: Mapped[str | None] = mapped_column(String(128), nullable=True, unique=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="proposed")
    regime_at_entry: Mapped[str | None] = mapped_column(String(48), nullable=True)
    rationale_summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    realized_pnl: Mapped[float | None] = mapped_column(Float, nullable=True)
    spy_benchmark_return_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now
    )

    reviews: Mapped[list[TradeReview]] = relationship(
        back_populates="paper_trade", cascade="all, delete-orphan"
    )


class TradeReview(Base):
    """Post-trade attribution & T+5/T+20 reflection records for episodic learning."""

    __tablename__ = "trade_reviews"
    __table_args__ = (Index("ix_trade_reviews_trade_horizon", "paper_trade_id", "horizon"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    paper_trade_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("paper_trades.id", ondelete="CASCADE"), nullable=False
    )
    horizon: Mapped[str] = mapped_column(String(24), nullable=False, default="POST_CLOSE")
    quadrant_outcome: Mapped[str] = mapped_column(String(64), nullable=False)
    alpha_vs_spy_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    regime_label: Mapped[str | None] = mapped_column(String(48), nullable=True)
    lessons_markdown: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )

    paper_trade: Mapped[PaperTrade] = relationship(back_populates="reviews")


class SecFilingDocument(Base):
    """Cached metadata for lazy-ingested SEC EDGAR 10-K / 10-Q / 8-K filings."""

    __tablename__ = "sec_filing_cache"
    __table_args__ = (
        UniqueConstraint("accession_number", name="uq_sec_filing_accession"),
        Index("ix_sec_filing_symbol_form_date", "symbol", "form_type", "filing_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    cik: Mapped[str] = mapped_column(String(16), nullable=False)
    accession_number: Mapped[str] = mapped_column(String(32), nullable=False)
    form_type: Mapped[str] = mapped_column(String(16), nullable=False)
    filing_date: Mapped[date] = mapped_column(Date, nullable=False)
    report_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    primary_document: Mapped[str] = mapped_column(String(255), nullable=False)
    source_url: Mapped[str] = mapped_column(String(512), nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    has_embeddings: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ingested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )

    chunks: Mapped[list[SecFilingChunk]] = relationship(
        back_populates="filing", cascade="all, delete-orphan"
    )


class SecFilingChunk(Base):
    """Section-aware SEC filing chunks supporting pgvector cosine + PostgreSQL tsvector BM25."""

    __tablename__ = "sec_filing_chunks"
    __table_args__ = (
        Index("ix_sec_filing_chunks_symbol_form", "symbol", "form_type", "filing_date"),
        Index("ix_sec_filing_chunks_tsv", "search_tsv", postgresql_using="gin"),
        Index(
            "ix_sec_filing_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    filing_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("sec_filing_cache.id", ondelete="CASCADE"), nullable=False
    )
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    form_type: Mapped[str] = mapped_column(String(16), nullable=False)
    filing_date: Mapped[date] = mapped_column(Date, nullable=False)
    section_title: Mapped[str] = mapped_column(String(160), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    token_estimate: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1536), nullable=True)
    search_tsv: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed(
            "to_tsvector('english', coalesce(section_title, '') || ' ' || content)",
            persisted=True,
        ),
        nullable=False,
    )

    filing: Mapped[SecFilingDocument] = relationship(back_populates="chunks")


class WatchdogAlert(Base):
    """Phase 5 intraday anomaly & catalyst Watchdog alerts persisted with deduplication."""

    __tablename__ = "watchdog_alerts"
    __table_args__ = (
        UniqueConstraint("alert_key", name="uq_watchdog_alert_key"),
        Index("ix_watchdog_alerts_created_ack", "created_at", "acknowledged"),
        Index("ix_watchdog_alerts_symbol", "symbol"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    alert_key: Mapped[str] = mapped_column(String(128), nullable=False)
    alert_type: Mapped[str] = mapped_column(String(48), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="medium")
    symbol: Mapped[str | None] = mapped_column(String(24), nullable=True)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    summary_markdown: Mapped[str] = mapped_column(Text, nullable=False, default="")
    metrics_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    regime_label: Mapped[str | None] = mapped_column(String(48), nullable=True)
    acknowledged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )


class EpisodicMemory(Base):
    """Long-term trade & regime attribution memory searchable via tsvector BM25 + pgvector."""

    __tablename__ = "episodic_memories"
    __table_args__ = (
        Index("ix_episodic_memories_symbol_regime", "symbol", "regime_label"),
        Index("ix_episodic_memories_tsv", "search_tsv", postgresql_using="gin"),
        Index(
            "ix_episodic_memories_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    paper_trade_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("paper_trades.id", ondelete="SET NULL"), nullable=True
    )
    symbol: Mapped[str] = mapped_column(String(24), nullable=False)
    regime_label: Mapped[str] = mapped_column(String(48), nullable=False, default="UNKNOWN")
    quadrant_outcome: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(240), nullable=False)
    lesson_text: Mapped[str] = mapped_column(Text, nullable=False)
    tags_json: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    alpha_vs_spy_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1536), nullable=True)
    search_tsv: Mapped[Any] = mapped_column(
        TSVECTOR,
        Computed(
            "to_tsvector('english', coalesce(symbol, '') || ' ' || coalesce(regime_label, '') || ' ' || coalesce(quadrant_outcome, '') || ' ' || coalesce(title, '') || ' ' || lesson_text)",
            persisted=True,
        ),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now
    )
