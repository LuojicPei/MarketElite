from __future__ import annotations

import logging
from collections.abc import Sequence
from urllib.parse import urlparse

import httpx
from langchain_core.messages import BaseMessage, SystemMessage
from langchain_openai import ChatOpenAI

from app.core.config import Settings

logger = logging.getLogger(__name__)

try:
    import tiktoken

    _ENCODING = tiktoken.get_encoding("cl100k_base")
except ImportError:  # pragma: no cover - optional tokenizer fallback
    _ENCODING = None


class LLMUnconfiguredError(RuntimeError):
    """Raised when requested LLM tier API key is not configured."""


def estimate_text_tokens(text: str) -> int:
    """Count tokens using cl100k_base when available, else conservative char/3 estimate."""
    if not text:
        return 0
    if _ENCODING is not None:
        return len(_ENCODING.encode(text, disallowed_special=()))
    return max(1, (len(text) + 2) // 3)


def estimate_message_tokens(message: BaseMessage) -> int:
    """Estimate token count for a LangChain BaseMessage including metadata overhead."""
    content = message.content if isinstance(message.content, str) else str(message.content)
    return estimate_text_tokens(content) + 6


def trim_messages_to_budget(
    messages: Sequence[BaseMessage],
    *,
    max_tokens: int,
) -> list[BaseMessage]:
    """Hard-trim conversation messages while keeping SystemMessage and newest turns intact."""
    if not messages:
        return []

    system_msgs = [m for m in messages if isinstance(m, SystemMessage)]
    other_msgs = [m for m in messages if not isinstance(m, SystemMessage)]

    budget = max(512, max_tokens)
    used = sum(estimate_message_tokens(m) for m in system_msgs)

    kept_reversed: list[BaseMessage] = []
    for msg in reversed(other_msgs):
        cost = estimate_message_tokens(msg)
        if used + cost > budget and kept_reversed:
            break
        kept_reversed.append(msg)
        used += cost

    kept_reversed.reverse()
    return [*system_msgs, *kept_reversed]


def build_fast_llm(settings: Settings, *, temperature: float = 0.1) -> ChatOpenAI:
    """Return Fast Tier ChatOpenAI client (used for rolling summary & parallel SEC subgraphs)."""
    api_key = settings.llm_fast_api_key.strip() or settings.llm_pro_api_key.strip()
    if not api_key:
        raise LLMUnconfiguredError("LLM_FAST_API_KEY is not configured in .env")
    return ChatOpenAI(
        model=settings.llm_fast_model,
        api_key=api_key,
        base_url=settings.llm_fast_base_url,
        temperature=temperature,
        timeout=30.0,
        max_retries=2,
    )


def build_pro_llm(
    settings: Settings, *, temperature: float = 0.1, streaming: bool = True
) -> ChatOpenAI:
    """Return Reasoning/Pro Tier ChatOpenAI client for Investigator planning and synthesis."""
    api_key = settings.llm_pro_api_key.strip() or settings.llm_fast_api_key.strip()
    if not api_key:
        raise LLMUnconfiguredError("LLM_PRO_API_KEY is not configured in .env")
    return ChatOpenAI(
        model=settings.llm_pro_model,
        api_key=api_key,
        base_url=settings.llm_pro_base_url,
        temperature=temperature,
        streaming=streaming,
        timeout=35.0,
        max_retries=2,
    )


async def embed_texts(
    texts: Sequence[str],
    settings: Settings,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> list[list[float]] | None:
    """Generate dense embeddings via OpenAI-compatible /embeddings API when key is configured."""
    if not texts:
        return []
    emb_host = urlparse(settings.llm_embedding_base_url).netloc.lower()
    api_key = settings.llm_embedding_api_key.strip()
    if not api_key and emb_host and emb_host == urlparse(settings.llm_fast_base_url).netloc.lower():
        api_key = settings.llm_fast_api_key.strip()
    if not api_key and emb_host and emb_host == urlparse(settings.llm_pro_base_url).netloc.lower():
        api_key = settings.llm_pro_api_key.strip()
    if not api_key:
        return None

    base = settings.llm_embedding_base_url.rstrip("/")
    url = f"{base}/embeddings"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": settings.llm_embedding_model,
        "input": list(texts),
        "dimensions": settings.llm_embedding_dim,
    }

    async def _post(client: httpx.AsyncClient) -> list[list[float]] | None:
        resp = await client.post(url, headers=headers, json=payload, timeout=25.0)
        if resp.status_code != 200:
            logger.warning("Embedding endpoint returned HTTP %s; falling back to BM25", resp.status_code)
            return None
        data = resp.json().get("data", [])
        if len(data) != len(texts):
            return None
        ordered = sorted(data, key=lambda item: int(item.get("index", 0)))
        vectors = [list(map(float, item["embedding"])) for item in ordered]
        if vectors and len(vectors[0]) != settings.llm_embedding_dim:
            logger.warning(
                "Embedding dimension %s != configured %s; skipping vector column",
                len(vectors[0]),
                settings.llm_embedding_dim,
            )
            return None
        return vectors

    try:
        if http_client is not None:
            return await _post(http_client)
        async with httpx.AsyncClient() as client:
            return await _post(client)
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        logger.warning("Embedding generation error (%s); lexical BM25 remains active", exc)
        return None
