from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import date
from typing import Any

import httpx
from bs4 import BeautifulSoup
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.db.models import SecFilingChunk, SecFilingDocument
from app.services.llm_router import embed_texts, estimate_text_tokens

logger = logging.getLogger(__name__)

_ITEM_HEADER_RE = re.compile(
    r"(?im)^\s*(item\s+\d+[a-z]?\.?\s*[^\n]{0,110})",
)

_CANONICAL_SECTION_LABELS: tuple[tuple[str, str], ...] = (
    ("item 1a", "Item 1A. Risk Factors"),
    ("item 1b", "Item 1B. Unresolved Staff Comments"),
    ("item 1c", "Item 1C. Cybersecurity"),
    ("item 1.", "Item 1. Business"),
    ("item 2.", "Item 2. MD&A / Properties"),
    ("item 3.", "Item 3. Legal / Market Risk"),
    ("item 7a", "Item 7A. Quantitative & Qualitative Market Risk"),
    ("item 7.", "Item 7. Management's Discussion & Analysis"),
    ("item 8.", "Item 8. Financial Statements"),
    ("item 9a", "Item 9A. Controls & Procedures"),
)


@dataclass(frozen=True)
class ParsedChunk:
    """Section-tagged SEC filing text chunk ready for PostgreSQL storage."""

    section_title: str
    chunk_index: int
    content: str
    token_estimate: int


def extract_clean_text_from_html(raw_html: str) -> str:
    """Strip inline XBRL headers, scripts, and heavy markup while keeping paragraph flow."""
    soup = BeautifulSoup(raw_html, "html.parser")
    for tag in soup(["script", "style", "noscript", "ix:header", "ix:hidden"]):
        tag.decompose()
    raw_text = soup.get_text(separator="\n")
    lines = [re.sub(r"[ \t\xa0]+", " ", line).strip() for line in raw_text.splitlines()]
    non_empty = [line for line in lines if line]
    return "\n".join(non_empty)


def _normalize_section_label(raw_header: str) -> str:
    lowered = re.sub(r"\s+", " ", raw_header.lower()).strip()
    for prefix, canonical in _CANONICAL_SECTION_LABELS:
        if lowered.startswith(prefix):
            return canonical
    cleaned = re.sub(r"\s+", " ", raw_header).strip()
    return cleaned[:150] or "General Disclosures"


def split_sec_filing_into_chunks(
    raw_text_or_html: str,
    *,
    max_tokens: int = 420,
    overlap_tokens: int = 60,
    max_chunks: int = 320,
) -> list[ParsedChunk]:
    """Segment a 10-K / 10-Q filing by SEC Item headers into overlapping token-bounded chunks."""
    if "<html" in raw_text_or_html[:2000].lower() or "<div" in raw_text_or_html[:4000].lower():
        text = extract_clean_text_from_html(raw_text_or_html)
    else:
        text = raw_text_or_html

    lines = text.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_title = "Cover & Executive Overview"
    current_lines: list[str] = []

    for line in lines:
        m = _ITEM_HEADER_RE.match(line)
        # Skip Table of Contents lines ending in page numbers like `Item 1A. Risk Factors 14`
        if m and len(line) < 120 and not re.search(r"\b\d{1,3}\s*$", line):
            if current_lines:
                sections.append((current_title, current_lines))
            current_title = _normalize_section_label(m.group(1))
            current_lines = [line]
        else:
            current_lines.append(line)

    if current_lines:
        sections.append((current_title, current_lines))

    chunks: list[ParsedChunk] = []
    chunk_idx = 0

    for sec_title, sec_lines in sections:
        words = " ".join(sec_lines).split()
        if len(words) < 25:
            continue
        # Approx 0.75 words/token -> convert token target safely into word window
        words_per_chunk = max(80, int(max_tokens * 0.72))
        overlap_words = max(15, int(overlap_tokens * 0.72))
        step = max(40, words_per_chunk - overlap_words)

        for start in range(0, len(words), step):
            slice_words = words[start : start + words_per_chunk]
            if len(slice_words) < 20:
                continue
            chunk_text = " ".join(slice_words)
            chunks.append(
                ParsedChunk(
                    section_title=sec_title,
                    chunk_index=chunk_idx,
                    content=chunk_text,
                    token_estimate=estimate_text_tokens(chunk_text),
                )
            )
            chunk_idx += 1
            if len(chunks) >= max_chunks:
                return chunks
            if start + words_per_chunk >= len(words):
                break

    return chunks


class SecEdgarIngestor:
    """Lazy-loading SEC EDGAR 10-K/10-Q fetcher and PostgreSQL chunk cache manager."""

    def __init__(
        self,
        settings: Settings,
        session_factory: async_sessionmaker[AsyncSession],
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory
        self._http_client = http_client
        self._cik_map: dict[str, str] = {}

    def _headers(self) -> dict[str, str]:
        return {
            "User-Agent": self._settings.sec_edgar_user_agent,
            "Accept-Encoding": "gzip, deflate",
        }

    async def resolve_cik(self, symbol: str) -> str:
        """Resolve equity ticker symbol to zero-padded 10-digit SEC CIK."""
        sym = symbol.upper().strip()
        if sym in self._cik_map:
            return self._cik_map[sym]

        async def _fetch(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.get(
                "https://www.sec.gov/files/company_tickers.json",
                headers=self._headers(),
                timeout=20.0,
            )
            resp.raise_for_status()
            return resp.json()

        if self._http_client is not None:
            raw = await _fetch(self._http_client)
        else:
            async with httpx.AsyncClient() as client:
                raw = await _fetch(client)

        for item in raw.values():
            ticker = str(item.get("ticker", "")).upper()
            cik_int = item.get("cik_str")
            if ticker and cik_int is not None:
                self._cik_map[ticker] = str(cik_int).zfill(10)

        if sym not in self._cik_map:
            raise ValueError(f"SEC CIK not found for ticker {sym}")
        return self._cik_map[sym]

    async def ensure_recent_filings_ingested(
        self,
        symbol: str,
        *,
        forms: tuple[str, ...] = ("10-K", "10-Q"),
        max_per_form: int = 1,
    ) -> list[dict[str, Any]]:
        """Lazy-ingest latest 10-K/10-Q into Postgres if absent, returning ingested summaries."""
        sym = symbol.upper().strip()

        async with self._session_factory() as session:
            existing_stmt = (
                select(SecFilingDocument)
                .where(
                    SecFilingDocument.symbol == sym,
                    SecFilingDocument.form_type.in_(forms),
                )
                .order_by(SecFilingDocument.filing_date.desc())
            )
            existing = list((await session.execute(existing_stmt)).scalars().all())
            existing_forms = {doc.form_type for doc in existing}
            if all(f in existing_forms for f in forms):
                return [
                    {
                        "accession_number": doc.accession_number,
                        "form_type": doc.form_type,
                        "filing_date": doc.filing_date.isoformat(),
                        "chunk_count": doc.chunk_count,
                        "cached": True,
                    }
                    for doc in existing
                ]

        cik = await self.resolve_cik(sym)

        async def _get_submissions(client: httpx.AsyncClient) -> dict[str, Any]:
            resp = await client.get(
                f"https://data.sec.gov/submissions/CIK{cik}.json",
                headers=self._headers(),
                timeout=20.0,
            )
            resp.raise_for_status()
            return resp.json()

        if self._http_client is not None:
            subs = await _get_submissions(self._http_client)
        else:
            async with httpx.AsyncClient() as client:
                subs = await _get_submissions(client)

        recent = subs.get("filings", {}).get("recent", {})
        form_list = recent.get("form", [])
        acc_list = recent.get("accessionNumber", [])
        date_list = recent.get("filingDate", [])
        rep_date_list = recent.get("reportDate", [])
        doc_list = recent.get("primaryDocument", [])

        candidates: list[dict[str, str]] = []
        counts_by_form = {f: 0 for f in forms}
        for idx, form in enumerate(form_list):
            if form not in counts_by_form or counts_by_form[form] >= max_per_form:
                continue
            acc = str(acc_list[idx])
            primary_doc = str(doc_list[idx])
            if not acc or not primary_doc:
                continue
            candidates.append(
                {
                    "form_type": str(form),
                    "accession_number": acc,
                    "filing_date": str(date_list[idx]),
                    "report_date": str(rep_date_list[idx]) if idx < len(rep_date_list) else "",
                    "primary_document": primary_doc,
                }
            )
            counts_by_form[form] += 1

        results: list[dict[str, Any]] = []
        cik_int_str = str(int(cik))

        for cand in candidates:
            acc = cand["accession_number"]
            async with self._session_factory() as session:
                found = (
                    await session.execute(
                        select(SecFilingDocument).where(
                            SecFilingDocument.accession_number == acc
                        )
                    )
                ).scalar_one_or_none()
                if found is not None:
                    results.append(
                        {
                            "accession_number": found.accession_number,
                            "form_type": found.form_type,
                            "filing_date": found.filing_date.isoformat(),
                            "chunk_count": found.chunk_count,
                            "cached": True,
                        }
                    )
                    continue

            acc_nodash = acc.replace("-", "")
            source_url = (
                f"https://www.sec.gov/Archives/edgar/data/{cik_int_str}/"
                f"{acc_nodash}/{cand['primary_document']}"
            )
            await asyncio.sleep(0.15)  # Respect SEC EDGAR fair-access throttle

            async def _download_filing(client: httpx.AsyncClient, url: str = source_url) -> str:
                resp = await client.get(url, headers=self._headers(), timeout=30.0)
                resp.raise_for_status()
                # Cap parsing payload to first 6MB so giant XBRL exhibits never stall memory
                return resp.text[:6_000_000]

            if self._http_client is not None:
                raw_html = await _download_filing(self._http_client)
            else:
                async with httpx.AsyncClient() as client:
                    raw_html = await _download_filing(client)

            parsed_chunks = split_sec_filing_into_chunks(raw_html)
            if not parsed_chunks:
                continue

            vectors: list[list[float]] | None = None
            batch_texts = [f"{c.section_title}\n{c.content}" for c in parsed_chunks]
            # Generate embeddings in clean batches of 50 if API configured
            all_vecs: list[list[float]] = []
            embed_ok = True
            for i in range(0, len(batch_texts), 50):
                batch_res = await embed_texts(batch_texts[i : i + 50], self._settings)
                if batch_res is None:
                    embed_ok = False
                    break
                all_vecs.extend(batch_res)
            if embed_ok and len(all_vecs) == len(parsed_chunks):
                vectors = all_vecs

            f_date = date.fromisoformat(cand["filing_date"][:10])
            r_date = (
                date.fromisoformat(cand["report_date"][:10])
                if cand["report_date"]
                else None
            )

            async with self._session_factory() as session:
                doc_stmt = (
                    pg_insert(SecFilingDocument)
                    .values(
                        symbol=sym,
                        cik=cik,
                        accession_number=acc,
                        form_type=cand["form_type"],
                        filing_date=f_date,
                        report_date=r_date,
                        primary_document=cand["primary_document"],
                        source_url=source_url,
                        chunk_count=len(parsed_chunks),
                        has_embeddings=vectors is not None,
                    )
                    .on_conflict_do_nothing(constraint="uq_sec_filing_accession")
                    .returning(SecFilingDocument.id)
                )
                inserted_id = (await session.execute(doc_stmt)).scalar_one_or_none()
                if inserted_id is not None:
                    chunk_rows = [
                        {
                            "filing_id": inserted_id,
                            "symbol": sym,
                            "form_type": cand["form_type"],
                            "filing_date": f_date,
                            "section_title": c.section_title,
                            "chunk_index": c.chunk_index,
                            "content": c.content,
                            "token_estimate": c.token_estimate,
                            "embedding": vectors[idx] if vectors is not None else None,
                        }
                        for idx, c in enumerate(parsed_chunks)
                    ]
                    await session.execute(pg_insert(SecFilingChunk).values(chunk_rows))
                await session.commit()

            results.append(
                {
                    "accession_number": acc,
                    "form_type": cand["form_type"],
                    "filing_date": f_date.isoformat(),
                    "chunk_count": len(parsed_chunks),
                    "has_embeddings": vectors is not None,
                    "cached": False,
                }
            )

        return results
