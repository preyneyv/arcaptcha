from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
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

    @classmethod
    def from_raw(cls, raw: Any) -> "CatalogEntry":
        if isinstance(raw, str):
            return cls(game_id=normalize_game_id(raw))

        if isinstance(raw, dict) and "game_id" in raw:
            return cls(game_id=normalize_game_id(str(raw["game_id"])))

        raise ValueError(
            "catalog entry must be a game id string or object with game_id"
        )

    def baseline_actions(self, environment: EnvironmentInfo | None) -> list[int] | None:
        if environment and environment.baseline_actions:
            return [int(value) for value in environment.baseline_actions]
        return None


@dataclass(frozen=True, slots=True)
class ScheduledEntry:
    scheduled_date: date
    cycle: int
    day_index: int
    entry: CatalogEntry

    @property
    def is_replay(self) -> bool:
        return self.cycle > 1

    def to_payload(
        self,
        environment: EnvironmentInfo | None,
    ) -> dict[str, Any]:
        baseline_actions = self.entry.baseline_actions(environment)

        return {
            "date": self.scheduled_date.isoformat(),
            "game_id": self.entry.game_id,
            "resolved_game_id": environment.game_id
            if environment
            else self.entry.game_id,
            "baseline_actions": baseline_actions,
        }


@dataclass(frozen=True, slots=True)
class GameCatalog:
    season_name: str
    entries: tuple[CatalogEntry, ...]

    @staticmethod
    def normalize_ids(game_ids: Iterable[str]) -> list[str]:
        return sorted(
            {
                normalize_game_id(game_id)
                for game_id in game_ids
                if isinstance(game_id, str) and game_id
            }
        )

    @classmethod
    def write_game_ids(
        cls,
        path: Path,
        game_ids: Iterable[str],
        season_name: str,
    ) -> None:
        normalized = cls.normalize_ids(game_ids)
        if not normalized:
            raise ValueError("cannot write an empty catalog")

        payload = {
            "season_name": season_name,
            "entries": normalized,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, indent=2) + "\n",
            encoding="utf-8",
        )

    @classmethod
    def write_from_environments(
        cls,
        path: Path,
        environments: Iterable[EnvironmentInfo],
        season_name: str,
    ) -> None:
        cls.write_game_ids(
            path,
            (environment.game_id for environment in environments),
            season_name,
        )

    @classmethod
    def load(cls, path: Path) -> "GameCatalog":
        raw = json.loads(path.read_text(encoding="utf-8"))
        entries = tuple(CatalogEntry.from_raw(item) for item in raw["entries"])
        if not entries:
            raise ValueError("catalog must contain at least one game")

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
            entry=self.entries[position],
        )

    def archive(
        self,
        now: datetime,
        season_start: date,
        environments: Iterable[EnvironmentInfo],
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
