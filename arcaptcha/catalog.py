from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

from arc_agi import EnvironmentInfo


def normalize_game_id(game_id: str) -> str:
    return game_id.split("-", 1)[0].lower()


def _sort_key(environment: EnvironmentInfo) -> datetime:
    if environment.date_downloaded is not None:
        return environment.date_downloaded
    return datetime.min.replace(tzinfo=timezone.utc)


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    game_id: str
    label: str | None = None
    optimal_action_count: int | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "CatalogEntry":
        return cls(
            game_id=normalize_game_id(str(raw["game_id"])),
            label=raw.get("label"),
            optimal_action_count=raw.get("optimal_action_count"),
        )

    def resolve_title(self, environment: EnvironmentInfo | None) -> str:
        if self.label:
            return self.label
        if environment and environment.title:
            return environment.title
        return self.game_id.upper()

    def reference_action_count(self, environment: EnvironmentInfo | None) -> int | None:
        if self.optimal_action_count is not None:
            return self.optimal_action_count
        if environment and environment.baseline_actions:
            return sum(environment.baseline_actions)
        return None

    def reference_source(self, environment: EnvironmentInfo | None) -> str:
        if self.optimal_action_count is not None:
            return "catalog"
        if environment and environment.baseline_actions:
            return "baseline"
        return "none"


@dataclass(frozen=True, slots=True)
class ScheduledEntry:
    scheduled_date: date
    cycle: int
    day_index: int
    season_name: str
    entry: CatalogEntry

    @property
    def is_replay(self) -> bool:
        return self.cycle > 1

    def reveal_at(self, reveal_hour_utc: int) -> datetime:
        return datetime.combine(
            self.scheduled_date + timedelta(days=1),
            time(hour=reveal_hour_utc, tzinfo=timezone.utc),
        )

    def to_payload(
        self,
        environment: EnvironmentInfo | None,
        now: datetime,
        reveal_hour_utc: int,
    ) -> dict[str, Any]:
        reference_action_count = self.entry.reference_action_count(environment)
        reveal_at = self.reveal_at(reveal_hour_utc)
        reference_revealed = now >= reveal_at

        return {
            "date": self.scheduled_date.isoformat(),
            "game_id": self.entry.game_id,
            "resolved_game_id": environment.game_id
            if environment
            else self.entry.game_id,
            "title": self.entry.resolve_title(environment),
            "cycle": self.cycle,
            "day_index": self.day_index,
            "is_replay": self.is_replay,
            "is_available": environment is not None,
            "season_name": self.season_name,
            "reveal_at": reveal_at.isoformat(),
            "reference_revealed": reference_revealed,
            "reference_action_count": reference_action_count
            if reference_revealed
            else None,
            "reference_source": self.entry.reference_source(environment),
            "tags": list(environment.tags or []) if environment else [],
        }


@dataclass(frozen=True, slots=True)
class GameCatalog:
    season_name: str
    entries: tuple[CatalogEntry, ...]

    @classmethod
    def load(cls, path: Path) -> "GameCatalog":
        raw = json.loads(path.read_text(encoding="utf-8"))
        entries = tuple(CatalogEntry.from_dict(item) for item in raw["entries"])
        return cls(
            season_name=str(raw.get("season_name", "public-demo")), entries=entries
        )

    def environment_index(
        self,
        environments: Iterable[EnvironmentInfo],
    ) -> dict[str, EnvironmentInfo]:
        latest: dict[str, EnvironmentInfo] = {}
        for environment in environments:
            base_id = normalize_game_id(environment.game_id)
            current = latest.get(base_id)
            if current is None or _sort_key(environment) >= _sort_key(current):
                latest[base_id] = environment
        return latest

    def current(
        self,
        now: datetime,
        season_start: date,
    ) -> ScheduledEntry:
        today = now.date()
        if today < season_start:
            today = season_start
        return self.for_date(today, season_start)

    def for_date(self, target_date: date, season_start: date) -> ScheduledEntry:
        if not self.entries:
            raise ValueError("catalog must contain at least one game")

        delta_days = max((target_date - season_start).days, 0)
        cycle_index, position = divmod(delta_days, len(self.entries))
        return ScheduledEntry(
            scheduled_date=target_date,
            cycle=cycle_index + 1,
            day_index=position + 1,
            season_name=self.season_name,
            entry=self.entries[position],
        )

    def archive(
        self,
        now: datetime,
        season_start: date,
        environments: Iterable[EnvironmentInfo],
        reveal_hour_utc: int,
        days_back: int,
        days_forward: int = 0,
    ) -> list[dict[str, Any]]:
        start_date = max(season_start, now.date() - timedelta(days=days_back))
        end_date = now.date() + timedelta(days=days_forward)
        environment_index = self.environment_index(environments)
        current = start_date
        payloads: list[dict[str, Any]] = []

        while current <= end_date:
            scheduled = self.for_date(current, season_start)
            payloads.append(
                scheduled.to_payload(
                    environment_index.get(scheduled.entry.game_id),
                    now,
                    reveal_hour_utc,
                )
            )
            current += timedelta(days=1)

        return payloads

    def find_entry(self, game_id: str) -> CatalogEntry | None:
        base_id = normalize_game_id(game_id)
        for entry in self.entries:
            if entry.game_id == base_id:
                return entry
        return None
