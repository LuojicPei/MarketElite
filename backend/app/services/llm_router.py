from __future__ import annotations

import ipaddress
import logging
import time
from collections.abc import Mapping, Sequence
from urllib.parse import urlparse

import httpx
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
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


_BLOCKED_METADATA_HOSTS = {
    "metadata.google.internal",
    "metadata.goog",
    "169.254.169.254",
    "100.100.100.200",
}


def validate_llm_base_url(raw_url: str, *, app_env: str = "development") -> str:
    """Validate OpenAI-compatible Base URL against SSRF and invalid schemes."""
    cleaned = raw_url.strip()
    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("API Base URL 必须以 https:// 或 http:// 开头并包含有效域名。")

    host = (parsed.hostname or "").strip().lower()
    if not host or host in _BLOCKED_METADATA_HOSTS:
        raise ValueError("不允许访问内网元数据地址。")

    if app_env.lower() == "production" and parsed.scheme != "https":
        raise ValueError("生产环境仅允许 HTTPS 协议的模型接口地址。")

    try:
        ip_obj = ipaddress.ip_address(host)
    except ValueError:
        ip_obj = None

    if ip_obj is not None:
        if ip_obj.is_link_local or ip_obj.is_multicast or ip_obj.is_unspecified:
            raise ValueError("不允许使用保留网段或链路本地 IP 作为接口地址。")
        if app_env.lower() == "production" and (ip_obj.is_private or ip_obj.is_loopback):
            raise ValueError("生产环境禁止指向内网或本机回环地址。")
    elif app_env.lower() == "production" and host in {"localhost", "host.docker.internal"}:
        raise ValueError("生产环境禁止使用 localhost 作为上游模型地址。")

    return cleaned


def resolve_llm_settings(
    base_settings: Settings, headers: Mapping[str, str]
) -> tuple[Settings, str]:
    """Resolve ephemeral per-request Settings supporting browser-local BYOK headers.

    Returns ``(effective_settings, key_source)`` where ``key_source`` is one of:
    - ``"byok"``: caller supplied own API key via ``X-LLM-Api-Key`` header
    - ``"server"``: ``allow_server_llm_fallback=True`` and server ``.env`` key configured
    - ``"none"``: no API key active for this request (public visitors stay isolated)
    """
    norm = {k.lower(): v.strip() for k, v in headers.items() if isinstance(v, str)}
    user_key = norm.get("x-llm-api-key", "")
    user_fast_key = norm.get("x-llm-fast-api-key", "") or user_key
    user_base_url = norm.get("x-llm-base-url", "")
    user_pro_model = norm.get("x-llm-pro-model", "")
    user_fast_model = norm.get("x-llm-fast-model", "")

    if user_key:
        updates: dict[str, str] = {
            "llm_pro_api_key": user_key,
            "llm_fast_api_key": user_fast_key,
        }
        if user_base_url:
            validated_url = validate_llm_base_url(user_base_url, app_env=base_settings.app_env)
            updates["llm_pro_base_url"] = validated_url
            updates["llm_fast_base_url"] = validated_url
        if user_pro_model:
            updates["llm_pro_model"] = user_pro_model
        if user_fast_model:
            updates["llm_fast_model"] = user_fast_model
        elif user_pro_model:
            updates["llm_fast_model"] = user_pro_model
        return base_settings.model_copy(update=updates), "byok"

    has_server_key = bool(
        base_settings.llm_pro_api_key.strip() or base_settings.llm_fast_api_key.strip()
    )
    if base_settings.allow_server_llm_fallback and has_server_key:
        return base_settings, "server"

    redacted_updates: dict[str, str] = {
        "llm_pro_api_key": "",
        "llm_fast_api_key": "",
        "llm_embedding_api_key": "",
    }
    return base_settings.model_copy(update=redacted_updates), "none"


async def test_llm_connection(
    *,
    api_key: str,
    base_url: str,
    model: str,
    app_env: str = "development",
) -> dict[str, object]:
    """Send a minimal probe request to validate a user-supplied OpenAI-compatible API config."""
    clean_key = api_key.strip()
    clean_model = model.strip()
    if not clean_key:
        raise ValueError("请输入 API Key 后再测试连接。")
    if not clean_model:
        raise ValueError("请指定要测试的模型名称（Model ID）。")

    validated_url = validate_llm_base_url(base_url, app_env=app_env)
    client = ChatOpenAI(
        model=clean_model,
        api_key=clean_key,
        base_url=validated_url,
        temperature=0.0,
        max_tokens=256,
        timeout=20.0,
        max_retries=0,
    )
    started = time.perf_counter()
    reply = await client.ainvoke([HumanMessage(content="只回复 OK 两个字母")])
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    raw_content = reply.content if isinstance(reply.content, str) else str(reply.content)
    return {
        "ok": True,
        "latency_ms": elapsed_ms,
        "model": clean_model,
        "base_url": validated_url,
        "reply_preview": raw_content.strip()[:60] or "已握手成功",
    }


_NON_CHAT_MODEL_MARKERS = (
    "embedding",
    "text-embedding",
    "tts-",
    "-tts",
    "whisper",
    "dall-e",
    "imagen",
    "moderation",
    "aqa",
    "babbage",
    "davinci",
    "realtime-audio",
)


async def fetch_available_models(
    *,
    api_key: str,
    base_url: str,
    app_env: str = "development",
) -> list[dict[str, str]]:
    """Query OpenAI-compatible GET /models using caller's BYOK key & return chat-capable IDs."""
    clean_key = api_key.strip()
    if not clean_key:
        raise ValueError("请先输入 API Key 后再拉取可用模型列表。")

    validated_url = validate_llm_base_url(base_url, app_env=app_env)
    endpoint = f"{validated_url.rstrip('/')}/models"
    headers = {
        "Authorization": f"Bearer {clean_key}",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(follow_redirects=True) as client:
        resp = await client.get(endpoint, headers=headers, timeout=15.0)
        resp.raise_for_status()
        payload = resp.json()

    raw_items = payload.get("data", []) if isinstance(payload, dict) else []
    if not isinstance(raw_items, list):
        return []

    seen: set[str] = set()
    models: list[dict[str, str]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        raw_id = str(item.get("id", "")).strip()
        if not raw_id:
            continue
        clean_id = raw_id.removeprefix("models/")
        low = clean_id.lower()
        if any(marker in low for marker in _NON_CHAT_MODEL_MARKERS):
            continue
        if clean_id in seen:
            continue
        seen.add(clean_id)
        models.append(
            {
                "id": clean_id,
                "owned_by": str(item.get("owned_by", "") or ""),
                "name": str(item.get("name", "") or clean_id),
            }
        )

    models.sort(key=lambda m: m["id"].lower())
    return models[:250]
