"""Create Phase 1 market structure, options GEX, regime, calendar, and trade tables.

Revision ID: 0001_phase1_tables
Revises:
Create Date: 2026-11-19
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_phase1_tables"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "market_daily_bars",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("symbol", sa.String(length=24), nullable=False),
        sa.Column("asset_class", sa.String(length=24), nullable=False),
        sa.Column("trade_date", sa.Date(), nullable=False),
        sa.Column("open", sa.Float(), nullable=False),
        sa.Column("high", sa.Float(), nullable=False),
        sa.Column("low", sa.Float(), nullable=False),
        sa.Column("close", sa.Float(), nullable=False),
        sa.Column("volume", sa.Float(), nullable=False),
        sa.Column("vwap", sa.Float(), nullable=True),
        sa.Column("trade_count", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("symbol", "trade_date", name="uq_market_daily_bars_symbol_date"),
    )
    op.create_index(
        "ix_market_daily_bars_symbol_date_desc",
        "market_daily_bars",
        ["symbol", "trade_date"],
    )

    op.create_table(
        "macro_series",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("series_id", sa.String(length=48), nullable=False),
        sa.Column("obs_date", sa.Date(), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("series_id", "obs_date", name="uq_macro_series_id_date"),
    )
    op.create_index("ix_macro_series_id_date", "macro_series", ["series_id", "obs_date"])

    op.create_table(
        "options_gex_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("symbol", sa.String(length=24), nullable=False),
        sa.Column("snapshot_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("spot_price", sa.Float(), nullable=False),
        sa.Column("net_gex", sa.Float(), nullable=False),
        sa.Column("call_wall", sa.Float(), nullable=True),
        sa.Column("put_wall", sa.Float(), nullable=True),
        sa.Column("zero_gamma", sa.Float(), nullable=True),
        sa.Column("put_call_ratio", sa.Float(), nullable=True),
        sa.Column("total_call_oi", sa.Integer(), nullable=False),
        sa.Column("total_put_oi", sa.Integer(), nullable=False),
        sa.Column("contracts_analyzed", sa.Integer(), nullable=False),
        sa.Column("assumption_label", sa.String(length=128), nullable=False),
        sa.Column("strike_profile_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("is_stale", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_options_gex_symbol_time",
        "options_gex_snapshots",
        ["symbol", "snapshot_time"],
    )

    op.create_table(
        "market_regime_daily",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("regime_date", sa.Date(), nullable=False),
        sa.Column("regime_label", sa.String(length=48), nullable=False),
        sa.Column("net_liquidity_billions", sa.Float(), nullable=True),
        sa.Column("net_liquidity_delta_20d", sa.Float(), nullable=True),
        sa.Column("yield_spread_10y2y", sa.Float(), nullable=True),
        sa.Column("hy_oas", sa.Float(), nullable=True),
        sa.Column("hyg_lqd_ratio", sa.Float(), nullable=True),
        sa.Column("vix_spot", sa.Float(), nullable=True),
        sa.Column("vix_3m", sa.Float(), nullable=True),
        sa.Column("vix_term_ratio", sa.Float(), nullable=True),
        sa.Column("vix_structure_state", sa.String(length=32), nullable=True),
        sa.Column("fear_greed_score", sa.Float(), nullable=True),
        sa.Column("fear_greed_label", sa.String(length=32), nullable=True),
        sa.Column(
            "fear_greed_components_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False
        ),
        sa.Column("rsp_spy_ratio", sa.Float(), nullable=True),
        sa.Column("pct_above_50ma", sa.Float(), nullable=True),
        sa.Column("pct_above_200ma", sa.Float(), nullable=True),
        sa.Column("sector_rotation_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("cross_asset_corr_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("cot_positioning_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("overview_payload_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("regime_date", name="uq_market_regime_daily_date"),
    )
    op.create_index("ix_market_regime_daily_date", "market_regime_daily", ["regime_date"])

    op.create_table(
        "economic_calendar",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("event_key", sa.String(length=160), nullable=False),
        sa.Column("event_type", sa.String(length=24), nullable=False),
        sa.Column("event_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("symbol", sa.String(length=24), nullable=True),
        sa.Column("country", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("impact", sa.String(length=24), nullable=False),
        sa.Column("actual", sa.Float(), nullable=True),
        sa.Column("estimate", sa.Float(), nullable=True),
        sa.Column("previous", sa.Float(), nullable=True),
        sa.Column("eps_actual", sa.Float(), nullable=True),
        sa.Column("eps_estimate", sa.Float(), nullable=True),
        sa.Column("revenue_estimate", sa.Float(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_key", name="uq_economic_calendar_event_key"),
    )
    op.create_index("ix_economic_calendar_time", "economic_calendar", ["event_time"])

    op.create_table(
        "consensus_eps_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("symbol", sa.String(length=24), nullable=False),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("period", sa.String(length=32), nullable=False),
        sa.Column("eps_avg", sa.Float(), nullable=True),
        sa.Column("eps_high", sa.Float(), nullable=True),
        sa.Column("eps_low", sa.Float(), nullable=True),
        sa.Column("number_analysts", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "symbol",
            "snapshot_date",
            "period",
            name="uq_consensus_eps_symbol_date_period",
        ),
    )
    op.create_index(
        "ix_consensus_eps_symbol_date",
        "consensus_eps_snapshots",
        ["symbol", "snapshot_date"],
    )

    op.create_table(
        "paper_trades",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("thread_id", sa.String(length=128), nullable=True),
        sa.Column("symbol", sa.String(length=24), nullable=False),
        sa.Column("side", sa.String(length=12), nullable=False),
        sa.Column("order_class", sa.String(length=24), nullable=False),
        sa.Column("qty", sa.Float(), nullable=False),
        sa.Column("entry_price", sa.Float(), nullable=True),
        sa.Column("stop_loss_price", sa.Float(), nullable=True),
        sa.Column("take_profit_price", sa.Float(), nullable=True),
        sa.Column("risk_budget_pct", sa.Float(), nullable=False),
        sa.Column("alpaca_order_id", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("regime_at_entry", sa.String(length=48), nullable=True),
        sa.Column("rationale_summary", sa.Text(), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("realized_pnl", sa.Float(), nullable=True),
        sa.Column("spy_benchmark_return_pct", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("alpaca_order_id"),
    )
    op.create_index("ix_paper_trades_symbol_created", "paper_trades", ["symbol", "created_at"])
    op.create_index("ix_paper_trades_thread_id", "paper_trades", ["thread_id"])

    op.create_table(
        "trade_reviews",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("paper_trade_id", sa.Integer(), nullable=False),
        sa.Column("horizon", sa.String(length=24), nullable=False),
        sa.Column("quadrant_outcome", sa.String(length=64), nullable=False),
        sa.Column("alpha_vs_spy_pct", sa.Float(), nullable=True),
        sa.Column("regime_label", sa.String(length=48), nullable=True),
        sa.Column("lessons_markdown", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["paper_trade_id"], ["paper_trades.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_trade_reviews_trade_horizon",
        "trade_reviews",
        ["paper_trade_id", "horizon"],
    )


def downgrade() -> None:
    op.drop_index("ix_trade_reviews_trade_horizon", table_name="trade_reviews")
    op.drop_table("trade_reviews")
    op.drop_index("ix_paper_trades_thread_id", table_name="paper_trades")
    op.drop_index("ix_paper_trades_symbol_created", table_name="paper_trades")
    op.drop_table("paper_trades")
    op.drop_index("ix_consensus_eps_symbol_date", table_name="consensus_eps_snapshots")
    op.drop_table("consensus_eps_snapshots")
    op.drop_index("ix_economic_calendar_time", table_name="economic_calendar")
    op.drop_table("economic_calendar")
    op.drop_index("ix_market_regime_daily_date", table_name="market_regime_daily")
    op.drop_table("market_regime_daily")
    op.drop_index("ix_options_gex_symbol_time", table_name="options_gex_snapshots")
    op.drop_table("options_gex_snapshots")
    op.drop_index("ix_macro_series_id_date", table_name="macro_series")
    op.drop_table("macro_series")
    op.drop_index("ix_market_daily_bars_symbol_date_desc", table_name="market_daily_bars")
    op.drop_table("market_daily_bars")
