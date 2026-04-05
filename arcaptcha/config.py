from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from arc_agi import OperationMode

PROJECT_ROOT = Path(__file__).resolve().parent.parent


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


def _read_operation_mode(name: str, default: OperationMode) -> OperationMode:
    raw = os.getenv(name)
    if raw is None:
        return default

    normalized = raw.strip().lower()
    for mode in OperationMode:
        if mode.value == normalized:
            return mode
    return default


@dataclass(frozen=True, slots=True)
class AppConfig:
    project_root: Path
    catalog_path: Path
    frontend_dist_dir: Path
    frontend_dev_url: str | None
    operation_mode: OperationMode
    season_start: date
    host: str
    port: int
    debug: bool
    archive_window_days: int
    reveal_hour_utc: int

    @property
    def environments_dir(self) -> Path:
        return self.project_root / "environment_files"

    @property
    def recordings_dir(self) -> Path:
        return self.project_root / "recordings"

    @classmethod
    def from_env(cls, project_root: Path | None = None) -> "AppConfig":
        root = project_root or PROJECT_ROOT
        reveal_hour_utc = _read_int("ARCAPTCHA_REVEAL_HOUR_UTC", 0)
        reveal_hour_utc = min(max(reveal_hour_utc, 0), 23)

        return cls(
            project_root=root,
            catalog_path=root / "arcaptcha" / "content" / "games.json",
            frontend_dist_dir=root / "web" / "dist",
            frontend_dev_url=os.getenv("ARCAPTCHA_FRONTEND_DEV_URL"),
            operation_mode=_read_operation_mode(
                "ARCAPTCHA_OPERATION_MODE",
                OperationMode.NORMAL,
            ),
            season_start=_read_date("ARCAPTCHA_SEASON_START", date(2026, 4, 4)),
            host=os.getenv("ARCAPTCHA_HOST", "127.0.0.1"),
            port=_read_int("ARCAPTCHA_PORT", 8000),
            debug=_read_bool("ARCAPTCHA_DEBUG", False),
            archive_window_days=max(
                7,
                _read_int("ARCAPTCHA_ARCHIVE_WINDOW_DAYS", 45),
            ),
            reveal_hour_utc=reveal_hour_utc,
        )
