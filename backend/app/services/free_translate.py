from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from typing import Any
from urllib.parse import quote

import httpx

from app.services.resilience import DualTTLCache

logger = logging.getLogger(__name__)

_TR_ITEM_PREFIX = "marketelite:tr:free:en_zh:v1:"


def polish_finance_zh(zh_text: str, en_source: str) -> str:
    """Apply lightweight financial term normalization only when matching English terms existed in source."""
    out = " ".join(str(zh_text or "").split())
    if not out:
        return out
    en_low = str(en_source or "").lower()

    if "alphabet" in en_low:
        out = out.replace("字母表公司", "Alphabet").replace("字母表", "Alphabet")
    if "s&p" in en_low or "standard & poor" in en_low:
        out = re.sub(r"标准普尔\s*500\s*指数?", "标普 500", out)
        out = re.sub(r"标普\s*500\s*指数", "标普 500", out)
    if "nasdaq" in en_low:
        out = out.replace("纳斯达克综合指数", "纳斯达克").replace("纳斯达克指数", "纳斯达克")
    if "federal reserve" in en_low or re.search(r"\bfed\b", en_low):
        out = out.replace("联邦储备委员会", "美联储")
    if re.search(r"\bpce\b", en_low):
        out = out.replace("个人消费支出", "PCE ")
    if re.search(r"\bcpi\b", en_low):
        out = out.replace("消费者物价指数", "CPI ").replace("居民消费价格指数", "CPI ")
    if "glp-1" in en_low:
        out = re.sub(r"GLP\s*-\s*1", "GLP-1", out, flags=re.IGNORECASE)
    if "nvidia" in en_low:
        out = out.replace("英伟达公司", "英伟达")
    if "anthropic" in en_low:
        out = out.replace("人类学", "Anthropic")
        if "artificial" not in en_low and "human" not in en_low and "man-made" not in en_low:
            out = out.replace("人为", "Anthropic")
    out = re.sub(r"<\s*b\s*>\s*", "<b>", out, flags=re.IGNORECASE)
    out = re.sub(r"\s*<\s*/\s*b\s*>", "</b>", out, flags=re.IGNORECASE)
    return " ".join(out.split())


def _chunk_texts_for_get(texts: list[str], *, max_items: int = 8, max_encoded_len: int = 1350) -> list[list[str]]:
    """Split text batch into safe GET query chunks well below URL length limits."""
    chunks: list[list[str]] = []
    cur_batch: list[str] = []
    cur_len = 0
    for txt in texts:
        enc_len = len(quote(txt, safe="")) + 6
        if cur_batch and (len(cur_batch) >= max_items or cur_len + enc_len > max_encoded_len):
            chunks.append(cur_batch)
            cur_batch = []
            cur_len = 0
        # Truncate ultra-long single paragraph safely so GET never returns 414
        safe_txt = txt[:900] if len(txt) > 900 else txt
        cur_batch.append(safe_txt)
        cur_len += min(enc_len, 1400)
    if cur_batch:
        chunks.append(cur_batch)
    return chunks


def _parse_clients5_response(payload: Any, expected_len: int) -> list[str]:
    """Normalize clients5 dict-chrome-ex JSON structure into flat strings matching input count."""
    if not isinstance(payload, list):
        return []
    out: list[str] = []
    for entry in payload:
        if isinstance(entry, str):
            out.append(entry)
        elif isinstance(entry, list) and entry:
            # Sometimes returned as [["中文...", "en...", ...], ...]
            first = entry[0]
            if isinstance(first, str):
                out.append(first)
            elif isinstance(first, list) and first and isinstance(first[0], str):
                out.append("".join(str(part[0]) for part in entry if isinstance(part, list) and part))
    if len(out) == expected_len:
        return out
    return []


async def _translate_chunk_clients5(
    chunk: list[str],
    client: httpx.AsyncClient,
) -> list[str] | None:
    """Query free Google Chrome Extension translation GET endpoint without API key."""
    if not chunk:
        return []
    params: list[tuple[str, str]] = [
        ("client", "dict-chrome-ex"),
        ("sl", "en"),
        ("tl", "zh-CN"),
        *[("q", text) for text in chunk],
    ]
    try:
        resp = await client.get(
            "https://clients5.google.com/translate_a/t",
            params=params,
            timeout=10.0,
        )
        if resp.status_code != 200:
            logger.debug("clients5 translate returned HTTP %s", resp.status_code)
            return None
        parsed = _parse_clients5_response(resp.json(), len(chunk))
        return parsed if parsed else None
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        logger.debug("clients5 translate error: %s", exc)
        return None


async def _translate_single_mymemory(text: str, client: httpx.AsyncClient) -> str | None:
    """Secondary fallback via MyMemory public translation API (no VPN / no API key)."""
    plain = re.sub(r"</?b>", "", text, flags=re.IGNORECASE).strip()
    clipped = plain[:480]
    if not clipped:
        return ""
    try:
        resp = await client.get(
            "https://api.mymemory.translated.net/get",
            params={"q": clipped, "langpair": "en|zh-CN"},
            timeout=8.0,
        )
        if resp.status_code != 200:
            return None
        body = resp.json()
        if int(body.get("responseStatus") or 0) != 200:
            return None
        translated = str((body.get("responseData") or {}).get("translatedText") or "").strip()
        return translated or None
    except (httpx.HTTPError, ValueError, TypeError):
        return None


async def translate_en_to_zh_free(
    texts: list[str],
    *,
    cache: DualTTLCache | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> tuple[list[str], bool]:
    """Translate English texts to polished Chinese with zero LLM quota using free NMT + Redis cache."""
    if not texts:
        return [], False

    cleaned_inputs = [" ".join(str(t or "").split()) for t in texts]
    results: list[str | None] = [None] * len(cleaned_inputs)
    uncached_indices: list[int] = []

    if cache is not None:
        keys = [
            f"{_TR_ITEM_PREFIX}{hashlib.sha256(txt.encode()).hexdigest()[:16]}"
            for txt in cleaned_inputs
        ]
        envs = await asyncio.gather(*(cache.read_envelope(k) for k in keys), return_exceptions=True)
        for idx, env in enumerate(envs):
            if (
                not isinstance(env, BaseException)
                and env
                and isinstance(env.get("payload"), dict)
                and env["payload"].get("zh")
            ):
                results[idx] = polish_finance_zh(str(env["payload"]["zh"]), cleaned_inputs[idx])
            elif cleaned_inputs[idx]:
                uncached_indices.append(idx)
            else:
                results[idx] = ""
    else:
        for idx, txt in enumerate(cleaned_inputs):
            if txt:
                uncached_indices.append(idx)
            else:
                results[idx] = ""

    translated_any = any(bool(r) for r in results)

    if uncached_indices:
        pending_texts = [cleaned_inputs[i] for i in uncached_indices]

        async def _execute_batches(client: httpx.AsyncClient) -> list[str | None]:
            out: list[str | None] = [None] * len(pending_texts)
            chunks = _chunk_texts_for_get(pending_texts)
            cursor = 0
            for chunk in chunks:
                batch_res = await _translate_chunk_clients5(chunk, client)
                if batch_res is not None:
                    for j, raw_zh in enumerate(batch_res):
                        out[cursor + j] = polish_finance_zh(raw_zh, chunk[j])
                else:
                    # Per-item MyMemory fallback when primary batch fails/throttles
                    mm_results = await asyncio.gather(
                        *(_translate_single_mymemory(src, client) for src in chunk),
                        return_exceptions=True,
                    )
                    for j, mm_val in enumerate(mm_results):
                        if isinstance(mm_val, str) and mm_val.strip():
                            out[cursor + j] = polish_finance_zh(mm_val, chunk[j])
                cursor += len(chunk)
            return out

        if http_client is not None:
            fresh_vals = await _execute_batches(http_client)
        else:
            # IMPORTANT: default httpx headers prevent browser-UA 429 blocks on clients5
            async with httpx.AsyncClient(follow_redirects=True) as client:
                fresh_vals = await _execute_batches(client)

        cache_writes = []
        for idx, zh_val in zip(uncached_indices, fresh_vals, strict=False):
            if zh_val:
                results[idx] = zh_val
                translated_any = True
                if cache is not None:
                    key = f"{_TR_ITEM_PREFIX}{hashlib.sha256(cleaned_inputs[idx].encode()).hexdigest()[:16]}"
                    cache_writes.append(
                        cache.write_envelope(
                            key,
                            payload={"zh": zh_val},
                            source="free_nmt",
                            soft_ttl_seconds=86400 * 7,
                            hard_ttl_seconds=86400 * 14,
                        )
                    )
        if cache_writes:
            await asyncio.gather(*cache_writes, return_exceptions=True)

    final_list = [
        results[idx] if results[idx] is not None else cleaned_inputs[idx]
        for idx in range(len(cleaned_inputs))
    ]
    return final_list, translated_any
