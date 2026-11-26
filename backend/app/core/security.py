from __future__ import annotations

import secrets
from typing import Any

from fastapi import HTTPException

from app.core.config import Settings


def is_admin_protection_active(settings: Settings) -> bool:
    """Return True when mutating/compute actions require a verified X-Admin-Token."""
    return bool(
        settings.admin_api_token.strip()
        or settings.app_env.lower() == "production"
        or settings.public_showcase_readonly
    )


def build_access_mode_snapshot(settings: Settings) -> dict[str, Any]:
    """Expose non-sensitive platform access-control posture to the Showcase UI."""
    admin_configured = bool(settings.admin_api_token.strip())
    return {
        "requires_admin_token": is_admin_protection_active(settings),
        "admin_configured": admin_configured,
        "public_showcase_readonly": bool(settings.public_showcase_readonly),
        "app_env": settings.app_env,
        "allow_server_llm_fallback": bool(settings.allow_server_llm_fallback),
    }


def require_admin_token(
    settings: Settings,
    x_admin_token: str | None,
    *,
    action_label: str = "Data & Eval Platform mutation",
) -> None:
    """Block unauthenticated public mutations when Admin/Showcase protection is active."""
    expected = settings.admin_api_token.strip()
    if expected:
        if not x_admin_token or not secrets.compare_digest(x_admin_token.strip(), expected):
            raise HTTPException(
                status_code=403,
                detail=f"Valid X-Admin-Token header required for {action_label}.",
            )
    elif settings.app_env.lower() == "production" or settings.public_showcase_readonly:
        raise HTTPException(
            status_code=403,
            detail=(
                f"{action_label} is locked in Public Read-Only Showcase mode unless "
                "ADMIN_API_TOKEN is configured and verified."
            ),
        )
