from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import SecFilingChunk
from app.rag.sec_edgar import SecEdgarIngestor
from app.services.llm_router import embed_texts

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RetrievedSecChunk:
    """Ranked SEC filing passage with filing provenance and hybrid retrieval scores."""

    chunk_id: int
    symbol: str
    form_type: str
    filing_date: str
    section_title: str
    chunk_index: int
    content: str
    rrf_score: float
    lexical_rank: int | None
    vector_rank: int | None


_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "from",
        "that",
        "this",
        "into",
        "over",
        "under",
        "what",
        "when",
        "how",
        "why",
        "are",
        "was",
    }
)


def _build_or_tsquery_text(query: str) -> str:
    terms = [
        t.lower()
        for t in re.findall(r"[a-zA-Z0-9]{2,}", query)
        if t.lower() not in _STOPWORDS
    ]
    deduped = list(dict.fromkeys(terms))[:12]
    return " | ".join(deduped)


def reciprocal_rank_fusion(
    vector_candidates: list[dict[str, Any]],
    lexical_candidates: list[dict[str, Any]],
    *,
    rrf_k: int = 60,
    top_k: int = 6,
    query: str = "",
) -> list[RetrievedSecChunk]:
    """Fuse dense vector and PostgreSQL BM25 candidates via RRF + section-diversity rerank."""
    fused: dict[int, dict[str, Any]] = {}

    for rank_idx, item in enumerate(vector_candidates, start=1):
        cid = int(item["chunk_id"])
        entry = fused.setdefault(cid, {**item, "score": 0.0, "vec_rank": None, "lex_rank": None})
        entry["score"] += 1.0 / (rrf_k + rank_idx)
        entry["vec_rank"] = rank_idx

    for rank_idx, item in enumerate(lexical_candidates, start=1):
        cid = int(item["chunk_id"])
        entry = fused.setdefault(cid, {**item, "score": 0.0, "vec_rank": None, "lex_rank": None})
        entry["score"] += 1.0 / (rrf_k + rank_idx)
        entry["lex_rank"] = rank_idx

    query_terms = {w for w in re.findall(r"[a-zA-Z0-9]{3,}", query.lower())}
    ranked_pool = list(fused.values())
    for item in ranked_pool:
        sec_title = str(item.get("section_title", ""))
        if sec_title == "Cover & Executive Overview" and int(item.get("chunk_index", 0)) <= 1:
            item["score"] -= 0.004
        if query_terms:
            title_hits = sum(1 for t in query_terms if t in sec_title.lower())
            item["score"] += min(0.01, title_hits * 0.003)

    ranked_pool.sort(key=lambda x: float(x["score"]), reverse=True)

    # Lightweight diversity rerank: limit >2 hits from exact same section when alternatives exist
    selected: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    section_counts: dict[str, int] = {}
    for item in ranked_pool:
        sec = str(item.get("section_title", ""))
        cnt = section_counts.get(sec, 0)
        if cnt < 2:
            selected.append(item)
            section_counts[sec] = cnt + 1
        else:
            deferred.append(item)

    combined = (selected + deferred)[:top_k]
    return [
        RetrievedSecChunk(
            chunk_id=int(it["chunk_id"]),
            symbol=str(it["symbol"]),
            form_type=str(it["form_type"]),
            filing_date=str(it["filing_date"]),
            section_title=str(it["section_title"]),
            chunk_index=int(it["chunk_index"]),
            content=str(it["content"]),
            rrf_score=round(float(it["score"]), 6),
            lexical_rank=it["lex_rank"],
            vector_rank=it["vec_rank"],
        )
        for it in combined
    ]


class HybridSecRetriever:
    """Lazy-ingesting SEC 10-K/10-Q retriever combining pgvector cosine + tsvector BM25 RRF."""

    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        ingestor: SecEdgarIngestor | None = None,
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory
        self._ingestor = ingestor or SecEdgarIngestor(settings, session_factory)

    async def search(
        self,
        symbol: str,
        query: str,
        *,
        form_type: str | None = None,
        top_k: int = 5,
        auto_ingest: bool = True,
    ) -> dict[str, Any]:
        """Search SEC filings with metadata filters and hybrid RRF fusion."""
        sym = symbol.upper().strip()
        ingested_docs: list[dict[str, Any]] = []
        if auto_ingest:
            forms = (form_type.upper(),) if form_type else ("10-K", "10-Q")
            try:
                ingested_docs = await self._ingestor.ensure_recent_filings_ingested(
                    sym, forms=forms, max_per_form=1
                )
            except (ValueError, httpx.HTTPError, SQLAlchemyError, OSError) as exc:
                logger.warning("SEC lazy ingestion issue for %s: %s", sym, exc)

        query_vec: list[float] | None = None
        embed_res = await embed_texts([query], self._settings)
        if embed_res:
            query_vec = embed_res[0]

        lexical_candidates: list[dict[str, Any]] = []
        vector_candidates: list[dict[str, Any]] = []

        async with self._session_factory() as session:
            filters = [SecFilingChunk.symbol == sym]
            if form_type:
                filters.append(SecFilingChunk.form_type == form_type.upper().strip())

            # 1. PostgreSQL Full-Text BM25 (`ts_rank_cd`): strict AND first, then weighted OR terms
            ts_q = func.websearch_to_tsquery("english", query)
            rank_expr = func.ts_rank_cd(SecFilingChunk.search_tsv, ts_q, 32).label("lex_score")
            lex_stmt = (
                select(SecFilingChunk, rank_expr)
                .where(*filters, SecFilingChunk.search_tsv.op("@@")(ts_q))
                .order_by(rank_expr.desc())
                .limit(20)
            )
            lex_rows = list((await session.execute(lex_stmt)).all())
            seen_lex_ids = {int(c.id) for c, _ in lex_rows}

            or_q_text = _build_or_tsquery_text(query)
            if len(lex_rows) < 8 and or_q_text:
                or_ts_q = func.to_tsquery("english", or_q_text)
                or_rank = func.ts_rank_cd(SecFilingChunk.search_tsv, or_ts_q, 32).label("lex_score")
                or_stmt = (
                    select(SecFilingChunk, or_rank)
                    .where(*filters, SecFilingChunk.search_tsv.op("@@")(or_ts_q))
                    .order_by(or_rank.desc())
                    .limit(25)
                )
                for chunk, score in (await session.execute(or_stmt)).all():
                    if int(chunk.id) not in seen_lex_ids:
                        lex_rows.append((chunk, score))
                        seen_lex_ids.add(int(chunk.id))

            for chunk, score in lex_rows:
                lexical_candidates.append(
                    {
                        "chunk_id": chunk.id,
                        "symbol": chunk.symbol,
                        "form_type": chunk.form_type,
                        "filing_date": chunk.filing_date.isoformat(),
                        "section_title": chunk.section_title,
                        "chunk_index": chunk.chunk_index,
                        "content": chunk.content,
                        "lex_score": float(score or 0.0),
                    }
                )

            # Fallback if strict websearch syntax yields 0 rows -> OR-based plain keyword scan
            if not lexical_candidates:
                fallback_stmt = (
                    select(SecFilingChunk)
                    .where(*filters)
                    .order_by(SecFilingChunk.filing_date.desc(), SecFilingChunk.chunk_index.asc())
                    .limit(10)
                )
                for chunk in (await session.execute(fallback_stmt)).scalars().all():
                    lexical_candidates.append(
                        {
                            "chunk_id": chunk.id,
                            "symbol": chunk.symbol,
                            "form_type": chunk.form_type,
                            "filing_date": chunk.filing_date.isoformat(),
                            "section_title": chunk.section_title,
                            "chunk_index": chunk.chunk_index,
                            "content": chunk.content,
                            "lex_score": 0.01,
                        }
                    )

            # 2. Dense pgvector cosine search when query & chunk vectors exist
            if query_vec is not None:
                dist_expr = SecFilingChunk.embedding.cosine_distance(query_vec).label("cos_dist")
                vec_stmt = (
                    select(SecFilingChunk, dist_expr)
                    .where(*filters, SecFilingChunk.embedding.is_not(None))
                    .order_by(dist_expr.asc())
                    .limit(20)
                )
                for chunk, _ in (await session.execute(vec_stmt)).all():
                    vector_candidates.append(
                        {
                            "chunk_id": chunk.id,
                            "symbol": chunk.symbol,
                            "form_type": chunk.form_type,
                            "filing_date": chunk.filing_date.isoformat(),
                            "section_title": chunk.section_title,
                            "chunk_index": chunk.chunk_index,
                            "content": chunk.content,
                        }
                    )

        fused = reciprocal_rank_fusion(
            vector_candidates,
            lexical_candidates,
            top_k=top_k,
            query=query,
        )
        return {
            "symbol": sym,
            "query": query,
            "mode": "hybrid_pgvector_bm25_rrf" if vector_candidates else "lexical_bm25_rrf",
            "filings": ingested_docs,
            "chunks": [
                {
                    "chunk_id": c.chunk_id,
                    "symbol": c.symbol,
                    "form_type": c.form_type,
                    "filing_date": c.filing_date,
                    "section_title": c.section_title,
                    "rrf_score": c.rrf_score,
                    "lexical_rank": c.lexical_rank,
                    "vector_rank": c.vector_rank,
                    "content": c.content,
                }
                for c in fused
            ],
        }
