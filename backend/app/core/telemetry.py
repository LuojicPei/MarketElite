from __future__ import annotations

import logging

from openinference.instrumentation.langchain import LangChainInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from app.core.config import Settings

logger = logging.getLogger(__name__)

_INITIALIZED = False


def init_phoenix_telemetry(settings: Settings) -> bool:
    """Configure OpenTelemetry + OpenInference LangChain instrumentation for Arize Phoenix."""
    global _INITIALIZED
    if _INITIALIZED or not settings.enable_telemetry:
        return _INITIALIZED

    try:
        resource = Resource.create({"service.name": f"{settings.app_name.lower()}-agent"})
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=settings.phoenix_collector_endpoint, timeout=5)
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        LangChainInstrumentor().instrument(tracer_provider=provider)
        _INITIALIZED = True
        logger.info(
            "Arize Phoenix OpenInference telemetry enabled -> %s",
            settings.phoenix_collector_endpoint,
        )
        return True
    except (RuntimeError, ValueError, OSError) as exc:
        logger.warning("Telemetry initialization skipped safely: %s", exc)
        return False
