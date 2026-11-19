from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve project root `.env` whether invoked from repo root or `backend/`
_ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
_LOCAL_ENV = Path(__file__).resolve().parents[2] / ".env"
_ENV_FILES = [str(p) for p in (_ROOT_ENV, _LOCAL_ENV) if p.exists()]


class Settings(BaseSettings):
    """Application settings loaded from environment variables and root `.env`."""

    model_config = SettingsConfigDict(
        env_file=_ENV_FILES or ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_name: str = "MarketElite"
    app_env: str = "development"
    log_level: str = "INFO"
    api_host: str = "0.0.0.0"
    api_port: int = 8100
    cors_origins: str = "http://localhost:3100"

    # PostgreSQL & Redis (conflict-free host ports)
    database_url: str = "postgresql+psycopg://marketelite:marketelite_dev@localhost:5433/marketelite"
    checkpoint_db_uri: str = "postgresql://marketelite:marketelite_dev@localhost:5433/marketelite?sslmode=disable"
    redis_url: str = "redis://localhost:6380/0"

    # Observability
    enable_telemetry: bool = True
    phoenix_collector_endpoint: str = "http://localhost:6007/v1/traces"
    phoenix_ui_url: str = "http://localhost:6007"

    # External Market Data APIs
    alpaca_api_key: str = Field(default="", repr=False)
    alpaca_secret_key: str = Field(default="", repr=False)
    alpaca_paper: bool = True
    fred_api_key: str = Field(default="", repr=False)
    finnhub_api_key: str = Field(default="", repr=False)
    fmp_api_key: str = Field(default="", repr=False)
    sec_edgar_user_agent: str = "MarketElite Research contact@example.com"

    # Unified OpenAI-Compatible LLM Router
    llm_fast_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    llm_fast_api_key: str = Field(default="", repr=False)
    llm_fast_model: str = "gemini-2.5-flash"

    llm_pro_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    llm_pro_api_key: str = Field(default="", repr=False)
    llm_pro_model: str = "gemini-2.5-flash"

    llm_embedding_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    llm_embedding_api_key: str = Field(default="", repr=False)
    llm_embedding_model: str = "gemini-embedding-001"
    llm_embedding_dim: int = 1536

    # Phase 3 Agent Safety & Rate Limits
    agent_max_steps: int = 8
    agent_wall_timeout_seconds: int = 45
    agent_max_context_tokens: int = 14000
    guest_chat_rpm: int = 12

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def libpq_dsn(self) -> str:
        """Convert SQLAlchemy-style DSN to standard psycopg libpq URI if needed."""
        return self.database_url.replace("postgresql+psycopg://", "postgresql://")

    def integration_readiness(self) -> list[dict]:
        """Return non-sensitive readiness flags for external APIs and LLM tiers."""
        return [
            {
                "id": "alpaca",
                "name": "Alpaca Market & Paper Trading",
                "category": "market_data",
                "requires_key": True,
                "configured": bool(self.alpaca_api_key.strip() and self.alpaca_secret_key.strip()),
                "mode": "Paper" if self.alpaca_paper else "Live",
            },
            {
                "id": "fred",
                "name": "FRED Macro & Liquidity",
                "category": "macro",
                "requires_key": True,
                "configured": bool(self.fred_api_key.strip()),
                "mode": "API Key",
            },
            {
                "id": "finnhub",
                "name": "Finnhub Earnings & EPS",
                "category": "fundamentals",
                "requires_key": True,
                "configured": bool(self.finnhub_api_key.strip()),
                "mode": "Free Tier",
            },
            {
                "id": "fmp",
                "name": "FMP Economic Calendar",
                "category": "macro",
                "requires_key": True,
                "configured": bool(self.fmp_api_key.strip()),
                "mode": "Free Tier",
            },
            {
                "id": "binance",
                "name": "Binance Vision (BTCUSDT)",
                "category": "crypto",
                "requires_key": False,
                "configured": True,
                "mode": "Keyless Public",
            },
            {
                "id": "cftc",
                "name": "CFTC COT Socrata JSON",
                "category": "positioning",
                "requires_key": False,
                "configured": True,
                "mode": "Keyless Public",
            },
            {
                "id": "sec_edgar",
                "name": "SEC EDGAR (10-K / 10-Q / 8-K)",
                "category": "rag",
                "requires_key": False,
                "configured": "@" in self.sec_edgar_user_agent and "example.com" not in self.sec_edgar_user_agent,
                "mode": "Header Policy",
            },
            {
                "id": "llm_fast",
                "name": f"LLM Fast Tier ({self.llm_fast_model})",
                "category": "llm",
                "requires_key": True,
                "configured": bool(self.llm_fast_api_key.strip()),
                "mode": "OpenAI-Compat",
            },
            {
                "id": "llm_pro",
                "name": f"LLM Reasoning Tier ({self.llm_pro_model})",
                "category": "llm",
                "requires_key": True,
                "configured": bool(self.llm_pro_api_key.strip()),
                "mode": "OpenAI-Compat",
            },
        ]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
