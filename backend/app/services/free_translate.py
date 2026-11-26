from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from app.core.config import get_settings
from app.services.resilience import DualTTLCache

logger = logging.getLogger(__name__)

_TR_ITEM_PREFIX = "marketelite:tr:free:en_zh:v2:"


def _needs_retry_zh(zh_text: str, en_source: str) -> bool:
    """Detect failed, mojibake, or half-untranslated English tails."""
    zh = str(zh_text or "").strip()
    if not zh:
        return bool(str(en_source or "").strip())
    up = zh.upper()
    if "\ufffd" in zh or "MYMEMORY" in up or "QUERY LENGTH LIMIT" in up or "Ã©" in zh or "â€™" in zh:
        return True
    en_plain = re.sub(r"</?b>", "", str(en_source or ""), flags=re.IGNORECASE)
    en_letters = len(re.findall(r"[A-Za-z]", en_plain))
    if en_letters < 18:
        return False
    zh_plain = re.sub(r"</?b>", "", zh, flags=re.IGNORECASE)
    cjk_count = len(re.findall(r"[\u4e00-\u9fff]", zh_plain))
    if cjk_count < 2:
        return True
    # Detect half-translated paragraph where English clause remained untranslated at tail
    ascii_words = re.findall(r"\b[a-z]{3,}\b", zh_plain)
    return len(ascii_words) >= 6 and cjk_count < len(ascii_words) * 2


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
    # Remove unbalanced trailing/orphan <b> or </b> tags left by NMT
    if out.count("<b>") != out.count("</b>"):
        out = re.sub(r"</?b>", "", out)
    return " ".join(out.split())


def _split_long_sentence(text: str, max_len: int = 580) -> list[str]:
    """Split long paragraph along clean sentence boundaries instead of mid-word truncation."""
    txt = " ".join(str(text or "").split())
    if len(txt) <= max_len:
        return [txt] if txt else []
    sentences = re.split(r"(?<=[.!?])\s+", txt)
    parts: list[str] = []
    cur = ""
    for s in sentences:
        if cur and len(cur) + 1 + len(s) > max_len:
            parts.append(cur.strip())
            cur = s
        else:
            cur = f"{cur} {s}".strip() if cur else s
    if cur:
        if len(cur) > max_len:
            parts.append(cur[:max_len].rsplit(" ", 1)[0] or cur[:max_len])
        else:
            parts.append(cur)
    return parts


def _chunk_texts_for_post(texts: list[str], *, max_items: int = 5, max_encoded_len: int = 1800) -> list[list[str]]:
    """Split text batch into compact form-POST chunks so Google clients5 translates every slot cleanly."""
    chunks: list[list[str]] = []
    cur_batch: list[str] = []
    cur_len = 0
    for txt in texts:
        safe_txt = txt
        enc_len = len(quote(safe_txt, safe="")) + 6
        if cur_batch and (len(cur_batch) >= max_items or cur_len + enc_len > max_encoded_len):
            chunks.append(cur_batch)
            cur_batch = []
            cur_len = 0
        cur_batch.append(safe_txt)
        cur_len += min(enc_len, 1800)
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
    """Query free Google Chrome Extension translation POST endpoint without API key (GET fallback on 405)."""
    if not chunk:
        return []
    query_params = {
        "client": "dict-chrome-ex",
        "sl": "en",
        "tl": "zh-CN",
    }
    try:
        resp = await client.post(
            "https://clients5.google.com/translate_a/t",
            params=query_params,
            content=urlencode([("q", text) for text in chunk]),
            headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
            timeout=10.0,
        )
        if resp.status_code == 405:
            resp = await client.get(
                "https://clients5.google.com/translate_a/t",
                params=[*query_params.items(), *[("q", text) for text in chunk]],
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


async def _translate_batch_llm_fallback(
    texts: list[str],
    client: httpx.AsyncClient,
) -> list[str | None]:
    """L3 production resilience fallback using configured fast OpenAI-compatible LLM when free NMT fails."""
    if not texts or os.environ.get("PYTEST_CURRENT_TEST"):
        return [None] * len(texts)
    settings = get_settings()
    api_key = settings.llm_fast_api_key.strip()
    base_url = settings.llm_fast_base_url.strip().rstrip("/")
    model = settings.llm_fast_model.strip()
    if not api_key or not base_url or not model:
        return [None] * len(texts)

    out: list[str | None] = [None] * len(texts)
    batch_size = 10
    for start in range(0, len(texts), batch_size):
        sub = texts[start : start + batch_size]
        numbered = "\n".join(f"[{i}] {txt}" for i, txt in enumerate(sub))
        try:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "temperature": 0.1,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are a financial news translator. Translate each numbered English line into "
                                "natural, accurate Simplified Chinese preserving <b>...</b> tags if present. "
                                "Return a valid JSON array of strings matching the exact input count."
                            ),
                        },
                        {"role": "user", "content": numbered},
                    ],
                },
                timeout=20.0,
            )
            if resp.status_code != 200:
                continue
            content = str(
                (((resp.json().get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
            ).strip()
            m = re.search(r"\[.*\]", content, flags=re.DOTALL)
            if not m:
                continue
            arr = json.loads(m.group(0))
            if isinstance(arr, list) and len(arr) == len(sub):
                for j, raw_zh in enumerate(arr):
                    cleaned = polish_finance_zh(str(raw_zh or ""), sub[j])
                    if not _needs_retry_zh(cleaned, sub[j]):
                        out[start + j] = cleaned
        except (httpx.HTTPError, ValueError, TypeError, KeyError):
            continue
    return out


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
                cached_zh = polish_finance_zh(str(env["payload"]["zh"]), cleaned_inputs[idx])
                if not _needs_retry_zh(cached_zh, cleaned_inputs[idx]):
                    results[idx] = cached_zh
                    continue
            if cleaned_inputs[idx]:
                uncached_indices.append(idx)
            else:
                results[idx] = ""
    else:
        for idx, txt in enumerate(cleaned_inputs):
            if txt:
                uncached_indices.append(idx)
            else:
                results[idx] = ""

    if uncached_indices:
        pending_texts = [cleaned_inputs[i] for i in uncached_indices]

        async def _execute_batches(client: httpx.AsyncClient) -> list[str | None]:
            # Expand long paragraphs along sentence bounds so nothing clips mid-word
            flat_texts: list[str] = []
            spans: list[tuple[int, int]] = []
            for p_txt in pending_texts:
                parts = _split_long_sentence(p_txt, max_len=580)
                if not parts:
                    parts = [p_txt]
                start = len(flat_texts)
                flat_texts.extend(parts)
                spans.append((start, len(flat_texts)))

            flat_out: list[str | None] = [None] * len(flat_texts)
            chunks = _chunk_texts_for_post(flat_texts)
            cursor = 0
            for chunk in chunks:
                batch_res = await _translate_chunk_clients5(chunk, client)
                if batch_res is not None:
                    for j, raw_zh in enumerate(batch_res):
                        cleaned = polish_finance_zh(raw_zh, chunk[j])
                        if not _needs_retry_zh(cleaned, chunk[j]):
                            flat_out[cursor + j] = cleaned
                cursor += len(chunk)

            # Retry any failed/partial slots individually (strip <b> tags if NMT choked on them)
            retry_indices = [i for i, val in enumerate(flat_out) if val is None]
            if retry_indices:
                sem = asyncio.Semaphore(6)

                async def _retry_one(slot_i: int) -> None:
                    async with sem:
                        src = flat_texts[slot_i]
                        single = await _translate_chunk_clients5([src], client)
                        if single and single[0]:
                            cand = polish_finance_zh(single[0], src)
                            if not _needs_retry_zh(cand, src):
                                flat_out[slot_i] = cand
                                return
                        plain_src = re.sub(r"</?b>", "", src, flags=re.IGNORECASE).strip()
                        if plain_src and plain_src != src:
                            single_p = await _translate_chunk_clients5([plain_src], client)
                            if single_p and single_p[0]:
                                cand_p = polish_finance_zh(single_p[0], plain_src)
                                if not _needs_retry_zh(cand_p, plain_src):
                                    flat_out[slot_i] = cand_p
                                    return
                        mm_val = await _translate_single_mymemory(plain_src or src, client)
                        if isinstance(mm_val, str) and mm_val.strip():
                            cand_m = polish_finance_zh(mm_val, src)
                            if not _needs_retry_zh(cand_m, src):
                                flat_out[slot_i] = cand_m

                await asyncio.gather(*(_retry_one(idx) for idx in retry_indices), return_exceptions=True)

            still_missing = [i for i, val in enumerate(flat_out) if val is None]
            if still_missing:
                llm_vals = await _translate_batch_llm_fallback(
                    [flat_texts[i] for i in still_missing],
                    client,
                )
                for idx, val in zip(still_missing, llm_vals, strict=False):
                    if val and not _needs_retry_zh(val, flat_texts[idx]):
                        flat_out[idx] = val

            out: list[str | None] = []
            for p_txt, (s_idx, e_idx) in zip(pending_texts, spans, strict=False):
                segs = [flat_out[k] for k in range(s_idx, e_idx)]
                if all(segs):
                    joined = polish_finance_zh(" ".join(s for s in segs if s), p_txt)
                    out.append(joined if not _needs_retry_zh(joined, p_txt) else None)
                else:
                    out.append(None)
            return out

        if http_client is not None:
            fresh_vals = await _execute_batches(http_client)
        else:
            # IMPORTANT: default httpx headers prevent browser-UA 429 blocks on clients5
            async with httpx.AsyncClient(follow_redirects=True) as client:
                fresh_vals = await _execute_batches(client)

        cache_writes = []
        for idx, zh_val in zip(uncached_indices, fresh_vals, strict=False):
            if zh_val and not _needs_retry_zh(zh_val, cleaned_inputs[idx]):
                results[idx] = zh_val
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

    non_empty_indices = [i for i, txt in enumerate(cleaned_inputs) if txt]
    translated_ok = sum(
        1
        for i in non_empty_indices
        if results[i] is not None and not _needs_retry_zh(str(results[i]), cleaned_inputs[i])
    )
    translated_all_ok = bool(non_empty_indices) and translated_ok == len(non_empty_indices)
    final_list = [
        results[idx] if results[idx] is not None else cleaned_inputs[idx]
        for idx in range(len(cleaned_inputs))
    ]
    return final_list, translated_all_ok
