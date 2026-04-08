from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from catalog import GameCatalog
from config import AppConfig
from daily_runtime import (
    ActionValidationError,
    DailyRuntimeManager,
    SessionMissingError,
    frame_to_payload,
    parse_action_request,
    parse_replay_actions,
)
from edition import EditionDateValidationError, resolve_edition_date
from environment_sync import EnvironmentSyncError, EnvironmentSyncService
from flask import Flask, Response, jsonify, redirect, request

LOGGER = logging.getLogger(__name__)

ALLOWED_CORS_HEADERS = "Content-Type, X-API-Key"
ALLOWED_CORS_METHODS = "GET, POST, OPTIONS"

_cleanup_thread_lock = threading.Lock()


def _validation_error_response(message: str) -> tuple[Response, int]:
    return (
        jsonify(
            {
                "error": "VALIDATION_ERROR",
                "message": message,
            }
        ),
        400,
    )


def _read_request_body() -> dict[str, object]:
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ActionValidationError("request body must be a JSON object")
    return data


def create_app(config: AppConfig | None = None) -> Flask:
    config = config or AppConfig.from_env()
    sync_service = EnvironmentSyncService(
        environments_dir=config.environments_dir,
        arc_base_url=config.arc_base_url,
        arc_api_key=config.arc_api_key,
        request_timeout_seconds=config.arc_request_timeout_seconds,
        logger=LOGGER,
    )
    sync_service.refresh_local_index()

    if not config.catalog_path.exists():
        raise RuntimeError(f"catalog not found: {config.catalog_path}")

    catalog = GameCatalog.load(config.catalog_path)
    runtime_manager = DailyRuntimeManager(
        sync_service=sync_service,
        session_ttl_seconds=config.session_ttl_seconds,
        logger=LOGGER,
    )
    app = Flask(__name__)
    app.config["JSON_SORT_KEYS"] = False
    app.extensions["arcaptcha"] = {
        "catalog": catalog,
        "config": config,
        "runtime_manager": runtime_manager,
        "sync_service": sync_service,
        "cleanup_thread": None,
    }

    _register_cleanup_thread(app, runtime_manager)
    _register_cors(app, config)
    _register_api_routes(app, catalog, config)
    _register_frontend_routes(app, config)
    return app


def _register_cleanup_thread(app: Flask, runtime_manager: DailyRuntimeManager) -> None:
    def ensure_cleanup_thread() -> None:
        with _cleanup_thread_lock:
            extension_state = app.extensions["arcaptcha"]
            cleaner = extension_state.get("cleanup_thread")
            if cleaner is not None and cleaner.is_alive():
                return

            def cleanup_loop() -> None:
                while True:
                    time.sleep(60)
                    cleaned = runtime_manager.cleanup_stale()
                    if cleaned > 0:
                        LOGGER.info("evicted %s stale daily session(s)", cleaned)

            cleaner = threading.Thread(
                target=cleanup_loop,
                name="arcaptcha-daily-cleaner",
                daemon=True,
            )
            extension_state["cleanup_thread"] = cleaner
            cleaner.start()

    ensure_cleanup_thread()

    @app.before_request
    def start_cleanup_thread() -> None:
        ensure_cleanup_thread()


def _register_cors(app: Flask, config: AppConfig) -> None:
    allowed_origins = set(config.cors_allowed_origins)
    if config.frontend_dev_url:
        allowed_origins.add(config.frontend_dev_url.rstrip("/"))

    @app.after_request
    def add_cors_headers(response: Response) -> Response:
        if not request.path.startswith("/api/"):
            return response

        origin = request.headers.get("Origin", "").rstrip("/")
        if origin not in allowed_origins:
            return response

        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = ALLOWED_CORS_HEADERS
        response.headers["Access-Control-Allow-Methods"] = ALLOWED_CORS_METHODS
        response.headers["Access-Control-Max-Age"] = "600"
        response.vary.add("Origin")
        return response


def _register_api_routes(
    app: Flask,
    catalog: GameCatalog,
    config: AppConfig,
) -> None:
    @app.get("/api/arcaptcha/health")
    def arcaptcha_health() -> Response | tuple[Response, int]:
        sync_service: EnvironmentSyncService = app.extensions["arcaptcha"][
            "sync_service"
        ]
        runtime_manager: DailyRuntimeManager = app.extensions["arcaptcha"][
            "runtime_manager"
        ]
        return jsonify(
            {
                "status": "ok",
                "operation_mode": "daily-runtime",
                "catalog_entries": len(catalog.entries),
                "available_environments": len(sync_service.get_local_environments()),
                "live_sessions": runtime_manager.session_count(),
                "frontend_built": (config.frontend_dist_dir / "index.html").exists(),
                "season_start": config.season_start.isoformat(),
            }
        )

    @app.post("/api/arcaptcha/bootstrap")
    def arcaptcha_bootstrap() -> Response | tuple[Response, int]:
        now = datetime.now(timezone.utc)
        runtime_manager: DailyRuntimeManager = app.extensions["arcaptcha"][
            "runtime_manager"
        ]

        try:
            data = _read_request_body()
            edition_date = resolve_edition_date(
                data.get("edition_date"),
                season_start=config.season_start,
                now=now,
            )
            replay_actions = parse_replay_actions(data.get("replay_actions"))
        except (ActionValidationError, EditionDateValidationError) as error:
            return _validation_error_response(str(error))

        scheduled = catalog.for_date(edition_date, config.season_start)

        api_key = request.headers.get("X-API-Key", "anonymous")
        try:
            environment, frame = runtime_manager.bootstrap(
                api_key=api_key,
                daily_date=edition_date.isoformat(),
                game_id=scheduled.entry.game_id,
                replay_actions=replay_actions,
            )
        except EnvironmentSyncError as error:
            return (
                jsonify(
                    {
                        "error": "ENVIRONMENT_SYNC_ERROR",
                        "message": str(error),
                    }
                ),
                503,
            )
        except Exception as error:  # pragma: no cover - defensive runtime fallback
            LOGGER.exception("failed to bootstrap daily environment")
            return (
                jsonify(
                    {
                        "error": "SERVER_ERROR",
                        "message": str(error),
                    }
                ),
                500,
            )

        payload = scheduled.to_payload(environment)
        payload.update(frame_to_payload(environment, frame))
        return jsonify(payload)

    @app.post("/api/arcaptcha/action")
    def arcaptcha_action() -> Response | tuple[Response, int]:
        runtime_manager: DailyRuntimeManager = app.extensions["arcaptcha"][
            "runtime_manager"
        ]
        try:
            now = datetime.now(timezone.utc)
            data = _read_request_body()
            action = parse_action_request(data)
            edition_date = resolve_edition_date(
                data.get("edition_date"),
                season_start=config.season_start,
                now=now,
            )
        except (ActionValidationError, EditionDateValidationError) as error:
            return _validation_error_response(str(error))

        api_key = request.headers.get("X-API-Key", "anonymous")
        try:
            environment, frame = runtime_manager.apply_action(
                api_key=api_key,
                daily_date=edition_date.isoformat(),
                action=action,
            )
        except SessionMissingError as error:
            return (
                jsonify(
                    {
                        "error": "SESSION_MISSING",
                        "message": str(error),
                    }
                ),
                404,
            )
        except Exception as error:  # pragma: no cover - defensive runtime fallback
            LOGGER.exception("failed to apply daily action")
            return (
                jsonify(
                    {
                        "error": "SERVER_ERROR",
                        "message": str(error),
                    }
                ),
                500,
            )

        return jsonify(frame_to_payload(environment, frame))

    @app.post("/api/arcaptcha/unload")
    def arcaptcha_unload() -> Response | tuple[Response, int]:
        runtime_manager: DailyRuntimeManager = app.extensions["arcaptcha"][
            "runtime_manager"
        ]
        try:
            edition_date = resolve_edition_date(
                _read_request_body().get("edition_date"),
                season_start=config.season_start,
                now=datetime.now(timezone.utc),
            )
        except (ActionValidationError, EditionDateValidationError) as error:
            return _validation_error_response(str(error))

        api_key = request.headers.get("X-API-Key", "anonymous")
        destroyed = runtime_manager.destroy_session(
            api_key,
            edition_date.isoformat(),
        )
        return jsonify({"status": "ok", "destroyed": destroyed})


def _register_frontend_routes(app: Flask, config: AppConfig) -> None:
    @app.get("/")
    def frontend_index():
        return redirect("https://arcaptcha.io", code=307)
