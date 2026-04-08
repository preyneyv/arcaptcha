from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _normalize_origin(raw: str) -> str:
    return raw.strip().rstrip("/")


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _read_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default

    try:
        return int(raw)
    except ValueError:
        return default


def _read_date(name: str, default: date) -> date:
    raw = os.getenv(name)
    if raw is None:
        return default

    try:
        return date.fromisoformat(raw)
    except ValueError:
        return default


def _read_origins(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name)
    if raw is None:
        return default

    origins = tuple(
        origin
        for origin in (_normalize_origin(value) for value in raw.split(","))
        if origin
    )
    return origins or default


@dataclass(frozen=True, slots=True)
class AppConfig:
    project_root: Path
    catalog_path: Path
    frontend_dist_dir: Path
    frontend_dev_url: str | None
    cors_allowed_origins: tuple[str, ...]
    arc_base_url: str
    arc_api_key: str
    arc_request_timeout_seconds: int
    session_ttl_seconds: int
    season_start: date
    host: str
    port: int
    debug: bool
    force_game_id: str | None = None

    @property
    def environments_dir(self) -> Path:
        return self.project_root / "environment_files"

    @property
    def recordings_dir(self) -> Path:
        return self.project_root / "recordings"

    @classmethod
    def from_env(cls, project_root: Path | None = None) -> "AppConfig":
        root = project_root or PROJECT_ROOT

        return cls(
            project_root=root,
            catalog_path=root / "arcaptcha" / "content" / "games.json",
            frontend_dist_dir=root / "web" / "dist",
            frontend_dev_url=os.getenv("ARCAPTCHA_FRONTEND_DEV_URL"),
            cors_allowed_origins=_read_origins(
                "ARCAPTCHA_CORS_ORIGINS",
                ("https://arcaptcha.io",),
            ),
            arc_base_url=os.getenv("ARC_BASE_URL", "https://three.arcprize.org"),
            arc_api_key=os.getenv("ARC_API_KEY", ""),
            arc_request_timeout_seconds=max(
                1,
                _read_int("ARCAPTCHA_ARC_REQUEST_TIMEOUT_SECONDS", 10),
            ),
            session_ttl_seconds=max(
                30,
                _read_int("ARCAPTCHA_SESSION_TTL_SECONDS", 900),
            ),
            season_start=_read_date("ARCAPTCHA_SEASON_START", date(2026, 4, 4)),
            host=os.getenv("ARCAPTCHA_HOST", "127.0.0.1"),
            port=_read_int("ARCAPTCHA_PORT", 8000),
            debug=_read_bool("ARCAPTCHA_DEBUG", False),
            force_game_id=os.getenv("ARCAPTCHA_FORCE_GAME_ID"),
        )
