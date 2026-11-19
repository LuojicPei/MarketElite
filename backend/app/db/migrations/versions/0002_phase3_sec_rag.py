"""Create Phase 3 SEC filing lazy-cache and pgvector+tsvector hybrid RAG tables.

Revision ID: 0002_phase3_sec_rag
Revises: 0001_phase1_tables
Create Date: 2026-11-19
"""
from __future__ import annotations

from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_phase3_sec_rag"
down_revision: str | Sequence[str] | None = "0001_phase1_tables"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "sec_filing_cache",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("symbol", sa.String(length=24), nullable=False),
        sa.Column("cik", sa.String(length=16), nullable=False),
        sa.Column("accession_number", sa.String(length=32), nullable=False),
        sa.Column("form_type", sa.String(length=16), nullable=False),
        sa.Column("filing_date", sa.Date(), nullable=False),
        sa.Column("report_date", sa.Date(), nullable=True),
        sa.Column("primary_document", sa.String(length=255), nullable=False),
        sa.Column("source_url", sa.String(length=512), nullable=False),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("has_embeddings", sa.Boolean(), nullable=False),
        sa.Column("ingested_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("accession_number", name="uq_sec_filing_accession"),
    )
    op.create_index(
        "ix_sec_filing_symbol_form_date",
        "sec_filing_cache",
        ["symbol", "form_type", "filing_date"],
    )

    op.create_table(
        "sec_filing_chunks",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("filing_id", sa.Integer(), nullable=False),
        sa.Column("symbol", sa.String(length=24), nullable=False),
        sa.Column("form_type", sa.String(length=16), nullable=False),
        sa.Column("filing_date", sa.Date(), nullable=False),
        sa.Column("section_title", sa.String(length=160), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("token_estimate", sa.Integer(), nullable=False),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(dim=1536), nullable=True),
        sa.Column(
            "search_tsv",
            postgresql.TSVECTOR(),
            sa.Computed(
                "to_tsvector('english', coalesce(section_title, '') || ' ' || content)",
                persisted=True,
            ),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["filing_id"], ["sec_filing_cache.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_sec_filing_chunks_symbol_form",
        "sec_filing_chunks",
        ["symbol", "form_type", "filing_date"],
    )
    op.create_index(
        "ix_sec_filing_chunks_tsv",
        "sec_filing_chunks",
        ["search_tsv"],
        postgresql_using="gin",
    )
    op.create_index(
        "ix_sec_filing_chunks_embedding_hnsw",
        "sec_filing_chunks",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "vector_cosine_ops"},
    )


def downgrade() -> None:
    op.drop_index("ix_sec_filing_chunks_embedding_hnsw", table_name="sec_filing_chunks")
    op.drop_index("ix_sec_filing_chunks_tsv", table_name="sec_filing_chunks")
    op.drop_index("ix_sec_filing_chunks_symbol_form", table_name="sec_filing_chunks")
    op.drop_table("sec_filing_chunks")
    op.drop_index("ix_sec_filing_symbol_form_date", table_name="sec_filing_cache")
    op.drop_table("sec_filing_cache")
