from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Sequence

from arc_agi import EnvironmentInfo
from arc_agi.local_wrapper import LocalEnvironmentWrapper
from arcengine import FrameDataRaw, GameAction
from environment_sync import EnvironmentSyncService

LOGGER = logging.getLogger(__name__)


TERMINAL_STATES = {
    "WIN",
    "FAIL",
    "FAILED",
    "LOSS",
    "LOSE",
    "LOST",
    "GAME_OVER",
    "GAMEOVER",
}


class SessionMissingError(RuntimeError):
    pass


class ActionValidationError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class ReplayAction:
    action: GameAction
    data: dict[str, Any]


@dataclass(slots=True)
class LiveSession:
    daily_date: str
    environment_info: EnvironmentInfo
    wrapper: LocalEnvironmentWrapper
    last_action_at: datetime
    lock: threading.Lock = field(default_factory=threading.Lock)


def parse_replay_actions(raw: object) -> list[ReplayAction]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ActionValidationError("replay_actions must be an array")

    return [_parse_action_record(item) for item in raw]


def parse_action_request(raw: object) -> ReplayAction:
    if not isinstance(raw, dict):
        raise ActionValidationError("request body must be a JSON object")
    return _parse_action_record(raw)


def frame_to_payload(
    environment_info: EnvironmentInfo,
    frame: FrameDataRaw,
) -> dict[str, Any]:
    state = frame.state.name if hasattr(frame.state, "name") else str(frame.state)
    return {
        "game_id": environment_info.game_id,
        "state": state,
        "levels_completed": int(frame.levels_completed),
        "win_levels": int(frame.win_levels),
        "full_reset": bool(getattr(frame, "full_reset", False)),
        "available_actions": _serialize_available_actions(frame.available_actions),
        "frame": _serialize_frame_layers(frame.frame),
    }


class DailyRuntimeManager:
    def __init__(
        self,
        *,
        sync_service: EnvironmentSyncService,
        session_ttl_seconds: int,
        logger: logging.Logger | None = None,
    ) -> None:
        self.sync_service = sync_service
        self.session_ttl = timedelta(seconds=max(30, session_ttl_seconds))
        self.logger = logger or LOGGER
        self._sessions: dict[tuple[str, str], LiveSession] = {}
        self._sessions_lock = threading.Lock()

    def session_count(self) -> int:
        with self._sessions_lock:
            return len(self._sessions)

    def bootstrap(
        self,
        *,
        api_key: str,
        daily_date: str,
        game_id: str,
        replay_actions: Sequence[ReplayAction],
    ) -> tuple[EnvironmentInfo, FrameDataRaw]:
        existing = self._get_session(api_key, daily_date)
        if existing is not None:
            with existing.lock:
                frame = existing.wrapper.observation_space
                if frame is not None:
                    existing.last_action_at = datetime.now(timezone.utc)
                    return existing.environment_info, frame
            self.destroy_session(api_key, daily_date)

        environment_info = self.sync_service.ensure_environment(game_id)
        wrapper = LocalEnvironmentWrapper(
            environment_info=environment_info,
            logger=self.logger,
            scorecard_id=f"arcaptcha-{daily_date}-{api_key[:16]}",
            save_recording=False,
            include_frame_data=True,
            recordings_dir=str(self.sync_service.environments_dir.parent / "recordings"),
            scorecard_manager=None,
            renderer=None,
        )

        frame = wrapper.observation_space
        if frame is None:
            raise RuntimeError(f"failed to initialize environment {environment_info.game_id}")

        for replay_action in replay_actions:
            next_frame = wrapper.step(replay_action.action, data=replay_action.data)
            if next_frame is None:
                raise RuntimeError(
                    f"failed to replay action {replay_action.action.name} for {environment_info.game_id}"
                )
            frame = next_frame

        if _is_terminal_state(frame):
            return environment_info, frame

        session = LiveSession(
            daily_date=daily_date,
            environment_info=environment_info,
            wrapper=wrapper,
            last_action_at=datetime.now(timezone.utc),
        )
        with self._sessions_lock:
            self._sessions[self._session_key(api_key, daily_date)] = session

        return environment_info, frame

    def apply_action(
        self,
        *,
        api_key: str,
        daily_date: str,
        action: ReplayAction,
    ) -> tuple[EnvironmentInfo, FrameDataRaw]:
        session = self._get_session(api_key, daily_date)
        if session is None:
            raise SessionMissingError("no active daily session")

        with session.lock:
            frame = session.wrapper.step(action.action, data=action.data)
            if frame is None:
                raise RuntimeError(
                    f"failed to apply action {action.action.name} to {session.environment_info.game_id}"
                )
            session.last_action_at = datetime.now(timezone.utc)

        if _is_terminal_state(frame):
            self.destroy_session(api_key, daily_date)

        return session.environment_info, frame

    def destroy_session(self, api_key: str, daily_date: str) -> bool:
        with self._sessions_lock:
            return self._sessions.pop(self._session_key(api_key, daily_date), None) is not None

    def cleanup_stale(self) -> int:
        cutoff = datetime.now(timezone.utc) - self.session_ttl
        stale_keys: list[tuple[str, str]] = []

        with self._sessions_lock:
            for key, session in self._sessions.items():
                if session.last_action_at <= cutoff:
                    stale_keys.append(key)

            for key in stale_keys:
                self._sessions.pop(key, None)

        return len(stale_keys)

    def _get_session(self, api_key: str, daily_date: str) -> LiveSession | None:
        with self._sessions_lock:
            return self._sessions.get(self._session_key(api_key, daily_date))

    @staticmethod
    def _session_key(api_key: str, daily_date: str) -> tuple[str, str]:
        return api_key, daily_date


def _parse_action_record(raw: object) -> ReplayAction:
    if not isinstance(raw, dict):
        raise ActionValidationError("action payload entries must be objects")

    action_name = raw.get("action")
    if not isinstance(action_name, str) or not action_name:
        raise ActionValidationError("missing action name")

    try:
        action = GameAction[action_name]
    except KeyError as error:
        raise ActionValidationError(f"unsupported action {action_name}") from error

    if action.name not in {
        "RESET",
        "ACTION1",
        "ACTION2",
        "ACTION3",
        "ACTION4",
        "ACTION5",
        "ACTION6",
        "ACTION7",
    }:
        raise ActionValidationError(f"unsupported action {action_name}")

    payload: dict[str, Any] = {}
    if action == GameAction.ACTION6:
        payload["x"] = _parse_coordinate(raw.get("x"), "x")
        payload["y"] = _parse_coordinate(raw.get("y"), "y")

    return ReplayAction(action=action, data=payload)


def _parse_coordinate(raw: object, field_name: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ActionValidationError(f"missing numeric {field_name} for ACTION6")

    value = int(raw)
    if value < 0 or value > 63:
        raise ActionValidationError(f"{field_name} must be between 0 and 63")
    return value


def _serialize_available_actions(actions: Iterable[Any] | None) -> list[int]:
    if not actions:
        return []

    serialized: list[int] = []
    for action in actions:
        if hasattr(action, "value"):
            serialized.append(int(action.value))
            continue
        serialized.append(int(action))
    return serialized


def _serialize_frame_layers(frame_layers: Iterable[Any] | None) -> list[Any]:
    if not frame_layers:
        return []

    serialized: list[Any] = []
    for layer in frame_layers:
        if hasattr(layer, "tolist"):
            serialized.append(layer.tolist())
        else:
            serialized.append(layer)
    return serialized


def _is_terminal_state(frame: FrameDataRaw) -> bool:
    state = frame.state.name if hasattr(frame.state, "name") else str(frame.state)
    normalized = state.strip().upper()
    return normalized in TERMINAL_STATES or normalized.startswith("FAIL")