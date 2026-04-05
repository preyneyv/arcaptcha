from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from arc_agi import Arcade
from arc_agi.server import create_app as create_arcade_app
from flask import Flask, Response, jsonify, send_from_directory

from .catalog import GameCatalog
from .config import AppConfig


def create_app(config: AppConfig | None = None) -> Flask:
    config = config or AppConfig.from_env()
    catalog = GameCatalog.load(config.catalog_path)
    arcade = Arcade(
        operation_mode=config.operation_mode,
        environments_dir=str(config.environments_dir),
        recordings_dir=str(config.recordings_dir),
    )
    app, _ = create_arcade_app(
        arcade,
        save_all_recordings=False,
        include_frame_data=True,
    )
    app.config["JSON_SORT_KEYS"] = False
    app.extensions["arcaptcha"] = {
        "catalog": catalog,
        "config": config,
        "arcade": arcade,
    }

    _register_api_routes(app, arcade, catalog, config)
    _register_frontend_routes(app, config)
    return app


def _register_api_routes(
    app: Flask,
    arcade: Arcade,
    catalog: GameCatalog,
    config: AppConfig,
) -> None:
    @app.get("/api/arcaptcha/health")
    def arcaptcha_health() -> Response | tuple[Response, int]:
        return jsonify(
            {
                "status": "ok",
                "operation_mode": config.operation_mode.value,
                "catalog_entries": len(catalog.entries),
                "available_environments": len(arcade.get_environments()),
                "frontend_built": (config.frontend_dist_dir / "index.html").exists(),
                "season_start": config.season_start.isoformat(),
            }
        )

    @app.get("/api/arcaptcha/daily")
    def arcaptcha_daily() -> Response | tuple[Response, int]:
        now = datetime.now(timezone.utc)
        scheduled = catalog.current(now, config.season_start)
        environment = catalog.environment_index(arcade.get_environments()).get(
            scheduled.entry.game_id
        )
        return jsonify(scheduled.to_payload(environment, now, config.reveal_hour_utc))


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
