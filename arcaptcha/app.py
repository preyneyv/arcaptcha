from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from pathlib import Path

from arc_agi import Arcade, EnvironmentInfo
from arc_agi.api import RestAPI
from arc_agi.server import create_app as create_arcade_app
from catalog import GameCatalog
from config import AppConfig
from flask import Flask, Response, jsonify, request, send_from_directory

LOGGER = logging.getLogger(__name__)

ALLOWED_CORS_HEADERS = "Content-Type, X-API-Key"
ALLOWED_CORS_METHODS = "GET, POST, OPTIONS"

_cleanup_thread_lock = threading.Lock()


def create_app(config: AppConfig | None = None) -> Flask:
    config = config or AppConfig.from_env()
    arcade = Arcade(
        operation_mode=config.operation_mode,
        environments_dir=str(config.environments_dir),
        recordings_dir=str(config.recordings_dir),
    )

    environments: tuple[EnvironmentInfo, ...] = ()
    try:
        environments = tuple(arcade.get_environments())
    except Exception as error:  # pragma: no cover - defensive startup fallback
        LOGGER.warning("failed to fetch available games at startup: %s", error)

    if environments:
        try:
            GameCatalog.write_from_environments(
                config.catalog_path,
                environments,
                season_name="arc-agi",
            )
        except Exception as error:  # pragma: no cover - defensive bootstrap fallback
            LOGGER.warning("failed to refresh catalog from available games: %s", error)

    catalog = GameCatalog.load(config.catalog_path)
    environment_index = catalog.environment_index(environments)

    app, api = create_arcade_app(
        arcade,
        save_all_recordings=False,
        include_frame_data=True,
    )
    app.config["JSON_SORT_KEYS"] = False
    app.extensions["arcaptcha"] = {
        "catalog": catalog,
        "config": config,
        "arcade": arcade,
        "api": api,
        "cleanup_thread": None,
        "environment_index": environment_index,
    }

    _register_cleanup_thread(app, api)
    _register_cors(app, config)
    _register_api_routes(app, catalog, config, environment_index)
    _register_frontend_routes(app, config)
    return app


def _register_cleanup_thread(app: Flask, api: RestAPI) -> None:
    def ensure_cleanup_thread() -> None:
        with _cleanup_thread_lock:
            extension_state = app.extensions["arcaptcha"]
            cleaner = extension_state.get("cleanup_thread")
            if cleaner is not None and cleaner.is_alive():
                return

            cleaner = threading.Thread(
                target=api.scorecard_cleanup_loop,
                name="arcaptcha-scorecard-cleaner",
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
    environment_index: dict[str, EnvironmentInfo],
) -> None:
    @app.get("/api/arcaptcha/health")
    def arcaptcha_health() -> Response | tuple[Response, int]:
        return jsonify(
            {
                "status": "ok",
                "operation_mode": config.operation_mode.value,
                "catalog_entries": len(catalog.entries),
                "available_environments": len(environment_index),
                "frontend_built": (config.frontend_dist_dir / "index.html").exists(),
                "season_start": config.season_start.isoformat(),
            }
        )

    @app.get("/api/arcaptcha/daily")
    def arcaptcha_daily() -> Response | tuple[Response, int]:
        now = datetime.now(timezone.utc)
        scheduled = catalog.current(now, config.season_start)
        environment = environment_index.get(scheduled.entry.game_id)
        return jsonify(scheduled.to_payload(environment))


def _register_frontend_routes(app: Flask, config: AppConfig) -> None:
    dist_dir = config.frontend_dist_dir.resolve()

    @app.get("/")
    def frontend_index() -> Response | tuple[str, int, dict[str, str]]:
        return _serve_frontend(dist_dir, config, None)

    @app.get("/<path:path>")
    def frontend_assets(path: str) -> Response | tuple[str, int, dict[str, str]]:
        if path.startswith("api/"):
            return "Not found", 404, {"Content-Type": "text/plain; charset=utf-8"}
        return _serve_frontend(dist_dir, config, path)


def _serve_frontend(
    dist_dir: Path,
    config: AppConfig,
    path: str | None,
) -> Response | tuple[str, int, dict[str, str]]:
    index_file = dist_dir / "index.html"
    if not index_file.exists():
        message = [
            "<html><body style='font-family: Consolas, monospace; padding: 24px;'>",
            "<h1>Arcaptcha frontend is not built yet.</h1>",
            "<p>Run <code>npm install</code> and <code>npm run dev</code> in <code>web</code> for local development.</p>",
        ]
        if config.frontend_dev_url:
            message.append(
                f"<p>Configured dev URL: <a href='{config.frontend_dev_url}'>{config.frontend_dev_url}</a></p>"
            )
        message.append("</body></html>")
        return "".join(message), 503, {"Content-Type": "text/html; charset=utf-8"}

    if path:
        candidate = (dist_dir / path).resolve()
        if candidate.is_file() and dist_dir in candidate.parents:
            return send_from_directory(dist_dir, path)

    return send_from_directory(dist_dir, "index.html")
