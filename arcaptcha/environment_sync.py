from __future__ import annotations

import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from arc_agi import EnvironmentInfo
from catalog import normalize_game_id

LOGGER = logging.getLogger(__name__)


class EnvironmentSyncError(RuntimeError):
    pass


class MissingEnvironmentError(EnvironmentSyncError):
    pass


def _sort_key(environment: EnvironmentInfo) -> datetime:
    if environment.date_downloaded is not None:
        return environment.date_downloaded
    return datetime.min.replace(tzinfo=timezone.utc)


def _derive_class_name(game_id: str) -> str:
    base_id = normalize_game_id(game_id)
    if len(base_id) >= 4:
        return base_id[0].upper() + base_id[1:4]
    if base_id:
        return base_id[0].upper() + base_id[1:]
    return "Game"


class EnvironmentSyncService:
    def __init__(
        self,
        *,
        environments_dir: Path,
        arc_base_url: str,
        arc_api_key: str,
        request_timeout_seconds: int,
        logger: logging.Logger | None = None,
    ) -> None:
        self.environments_dir = environments_dir
        self.arc_base_url = arc_base_url.rstrip("/")
        self.request_timeout_seconds = max(1, request_timeout_seconds)
        self.logger = logger or LOGGER

        self._api_key = arc_api_key.strip()
        self._api_key_lock = threading.Lock()
        self._index_lock = threading.Lock()
        self._download_lock = threading.Lock()
        self._local_environments: tuple[EnvironmentInfo, ...] = ()
        self._local_index: dict[str, tuple[EnvironmentInfo, ...]] = {}

        self.refresh_local_index()

    def refresh_local_index(self) -> tuple[EnvironmentInfo, ...]:
        environments: list[EnvironmentInfo] = []
        if self.environments_dir.exists() and self.environments_dir.is_dir():
            for metadata_file in self.environments_dir.rglob("metadata.json"):
                try:
                    environment = EnvironmentInfo.model_validate_json(
                        metadata_file.read_text(encoding="utf-8")
                    )
                    environment.local_dir = str(metadata_file.parent)
                    environments.append(environment)
                except Exception as error:  # pragma: no cover - defensive parse fallback
                    self.logger.warning(
                        "failed to load metadata from %s: %s",
                        metadata_file,
                        error,
                    )

        grouped: dict[str, list[EnvironmentInfo]] = {}
        for environment in environments:
            grouped.setdefault(normalize_game_id(environment.game_id), []).append(
                environment
            )

        index: dict[str, tuple[EnvironmentInfo, ...]] = {}
        for game_id, versions in grouped.items():
            index[game_id] = tuple(
                sorted(versions, key=_sort_key, reverse=True)
            )

        ordered = tuple(sorted(environments, key=_sort_key, reverse=True))
        with self._index_lock:
            self._local_environments = ordered
            self._local_index = index

        return ordered

    def get_local_environments(self) -> tuple[EnvironmentInfo, ...]:
        with self._index_lock:
            return self._local_environments

    def get_latest_environment(self, game_id: str) -> EnvironmentInfo | None:
        base_id = normalize_game_id(game_id)
        with self._index_lock:
            versions = self._local_index.get(base_id, ())
        return versions[0] if versions else None

    def get_environment(self, resolved_game_id: str) -> EnvironmentInfo | None:
        base_id = normalize_game_id(resolved_game_id)
        with self._index_lock:
            versions = self._local_index.get(base_id, ())
        for version in versions:
            if version.game_id == resolved_game_id:
                return version
        return None

    def ensure_environment(self, game_id: str) -> EnvironmentInfo:
        existing = self.get_latest_environment(game_id)
        if existing is not None:
            return existing
        return self.download_environment(game_id)

    def download_environment(self, game_id: str) -> EnvironmentInfo:
        base_id = normalize_game_id(game_id)
        existing = self.get_latest_environment(base_id)
        if existing is not None:
            return existing

        with self._download_lock:
            existing = self.get_latest_environment(base_id)
            if existing is not None:
                return existing

            metadata = self._fetch_metadata(base_id)
            if metadata is None:
                raise MissingEnvironmentError(
                    f"daily environment {base_id} could not be downloaded"
                )

            resolved_game_id = str(metadata.get("game_id") or base_id)
            version = metadata.get("version")
            if not version and "-" in resolved_game_id:
                version = resolved_game_id.split("-", 1)[1]
            if not version:
                raise MissingEnvironmentError(
                    f"daily environment {base_id} is missing version metadata"
                )

            version = str(version)
            class_name = str(metadata.get("class_name") or _derive_class_name(base_id))
            downloaded_at = datetime.now(timezone.utc)
            environment_dir = self.environments_dir / base_id / version
            environment_dir.mkdir(parents=True, exist_ok=True)

            normalized_metadata = dict(metadata)
            normalized_metadata["game_id"] = resolved_game_id
            normalized_metadata["tags"] = list(metadata.get("tags") or [])
            normalized_metadata["baseline_actions"] = list(
                metadata.get("baseline_actions") or []
            )
            normalized_metadata["date_downloaded"] = downloaded_at.isoformat()
            normalized_metadata["class_name"] = class_name

            metadata_file = environment_dir / "metadata.json"
            metadata_file.write_text(
                json.dumps(normalized_metadata, indent=2) + "\n",
                encoding="utf-8",
            )

            source_file = environment_dir / f"{class_name.lower()}.py"
            if not source_file.exists():
                source_code = self._fetch_source_code(resolved_game_id)
                source_file.write_text(source_code, encoding="utf-8")

            self.logger.info(
                "downloaded environment %s into %s",
                resolved_game_id,
                environment_dir,
            )
            self.refresh_local_index()

            downloaded = self.get_environment(resolved_game_id)
            if downloaded is None:
                raise MissingEnvironmentError(
                    f"downloaded environment {resolved_game_id} could not be indexed"
                )

            return downloaded

    def _fetch_metadata(self, game_id: str) -> dict[str, Any] | None:
        api_key = self._get_api_key()
        if not api_key:
            self.logger.warning("cannot fetch metadata for %s: no ARC API key", game_id)
            return None

        metadata_url = f"{self.arc_base_url}/api/games/{game_id}"
        headers = {
            "X-Api-Key": api_key,
            "Accept": "application/json",
        }

        try:
            response = requests.get(
                metadata_url,
                headers=headers,
                timeout=self.request_timeout_seconds,
            )

            if not response.ok:
                self.logger.warning(
                    "failed to fetch metadata for %s (status=%s): %s",
                    game_id,
                    response.status_code,
                    response.text,
                )
                return None

            metadata = response.json()
            self.logger.info("fetched metadata for %s", game_id)
            return metadata if isinstance(metadata, dict) else None
        except requests.exceptions.RequestException as error:
            self.logger.warning(
                "request error while fetching metadata for %s: %s",
                game_id,
                error,
            )
            return None
        except ValueError as error:
            self.logger.warning(
                "invalid JSON returned for %s metadata: %s",
                game_id,
                error,
            )
            return None

    def _fetch_source_code(self, resolved_game_id: str) -> str:
        api_key = self._get_api_key()
        if not api_key:
            raise MissingEnvironmentError(
                f"daily environment {resolved_game_id} could not be downloaded"
            )

        response = requests.get(
            f"{self.arc_base_url}/api/games/{resolved_game_id}/source",
            headers={
                "X-Api-Key": api_key,
                "Accept": "application/json",
            },
            timeout=self.request_timeout_seconds,
        )
        response.raise_for_status()
        return response.text

    def _get_api_key(self) -> str:
        if self._api_key:
            return self._api_key

        with self._api_key_lock:
            if self._api_key:
                return self._api_key

            response = requests.get(
                f"{self.arc_base_url}/api/games/anonkey",
                headers={"Accept": "application/json"},
                timeout=self.request_timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
            api_key = str(payload.get("api_key") or "")
            if not api_key:
                raise MissingEnvironmentError("ARC anon key endpoint returned no api_key")

            self._api_key = api_key
            self.logger.info("fetched anonymous ARC API key for environment sync")
            return self._api_key