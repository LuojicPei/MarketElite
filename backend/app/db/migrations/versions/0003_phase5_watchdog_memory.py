"""Create Phase 5 Watchdog alert and Episodic Memory long-term recall tables.

Revision ID: 0003_phase5_watchdog_memory
Revises: 0002_phase3_sec_rag
Create Date: 2026-11-20
"""
from __future__ import annotations

from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_phase5_watchdog_memory"
down_revision: str | Sequence[str] | None = "0002_phase3_sec_rag"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "watchdog_alerts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("alert_key", sa.String(length=128), nullable=False),
        sa.Column("alert_type", sa.String(length=48), nullable=False),
        sa.Column("severity", sa.String(length=16), nullable=False),
        sa.Column("symbol", sa.String(length=24), nullable=True),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("summary_markdown", sa.Text(), nullable=False),
        sa.Column("metrics_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("regime_label", sa.String(length=48), nullable=True),
        sa.Column("acknowledged", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("alert_key", name="uq_watchdog_alert_key"),
    )
    op.create_index(
        "ix_watchdog_alerts_created_ack",
        "watchdog_alerts",
        ["created_at", "acknowledged"],
    )
    op.create_index("ix_watchdog_alerts_symbol", "watchdog_alerts", ["symbol"])

    op.create_table(
        "episodic_memories",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("paper_trade_id", sa.Integer(), nullable=True),
        sa.Column("symbol", sa.String(length=24), nullable=False),
        sa.Column("regime_label", sa.String(length=48), nullable=False),
        sa.Column("quadrant_outcome", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=240), nullable=False),
        sa.Column("lesson_text", sa.Text(), nullable=False),
        sa.Column("tags_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("alpha_vs_spy_pct", sa.Float(), nullable=True),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(dim=1536), nullable=True),
        sa.Column(
            "search_tsv",
            postgresql.TSVECTOR(),
            sa.Computed(
                "to_tsvector('english', coalesce(symbol, '') || ' ' || coalesce(regime_label, '') || ' ' || coalesce(quadrant_outcome, '') || ' ' || coalesce(title, '') || ' ' || lesson_text)",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["paper_trade_id"], ["paper_trades.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_episodic_memories_symbol_regime",
        "episodic_memories",
        ["symbol", "regime_label"],
    )
    op.create_index(
        "ix_episodic_memories_tsv",
        "episodic_memories",
        ["search_tsv"],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_episodic_memories_embedding_hnsw",
        "episodic_memories",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_episodic_memories_embedding_hnsw", table_name="episodic_memories")
    op.drop_index("ix_episodic_memories_tsv", table_name="episodic_memories")
    op.drop_index("ix_episodic_memories_symbol_regime", table_name="episodic_memories")
    op.drop_table("episodic_memories")
    op.drop_index("ix_watchdog_alerts_symbol", table_name="watchdog_alerts")
    op.drop_index("ix_watchdog_alerts_created_ack", table_name="watchdog_alerts")
    op.drop_table("watchdog_alerts")
