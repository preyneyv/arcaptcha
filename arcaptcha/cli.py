from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from typing import Sequence

import uvicorn
from app import create_socketio_asgi_app
from catalog import GameCatalog
from config import AppConfig
from edition import EditionDateValidationError, resolve_edition_date
from environment_sync import EnvironmentSyncService

LOGGER = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="arcaptcha")
    subparsers = parser.add_subparsers(dest="command")

    serve_parser = subparsers.add_parser("serve", help="run the Arcaptcha server")
    serve_parser.add_argument("--host")
    serve_parser.add_argument("--port", type=int)
    serve_parser.add_argument("--debug", action="store_true")

    daily_parser = subparsers.add_parser(
        "daily", help="print the currently selected daily puzzle"
    )
    daily_parser.add_argument(
        "--edition-date",
        help="ISO date for the playable edition to inspect",
    )
    subparsers.add_parser("season", help="print the current season schedule")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command or "serve"

    config = AppConfig.from_env()

    if command in {"daily", "season"}:
        sync_service = EnvironmentSyncService(
            environments_dir=config.environments_dir,
            arc_base_url=config.arc_base_url,
            arc_api_key=config.arc_api_key,
            request_timeout_seconds=config.arc_request_timeout_seconds,
            logger=LOGGER,
        )
        sync_service.refresh_local_index()

        catalog = GameCatalog.load(config.catalog_path)
        local_environments = sync_service.get_local_environments()
        environment_index = catalog.environment_index(local_environments)

        if command == "daily":
            now = datetime.now(timezone.utc)
            try:
                edition_date = resolve_edition_date(
                    getattr(args, "edition_date", None),
                    season_start=config.season_start,
                    now=now,
                )
            except EditionDateValidationError as error:
                parser.error(str(error))

            scheduled = catalog.for_date(edition_date, config.season_start)
            environment = environment_index.get(scheduled.entry.game_id)
            payload = scheduled.to_payload(environment)
        else:
            payload = catalog.season_payload(config.season_start, environment_index)

        print(json.dumps(payload, indent=2))
        return

    host = args.host or config.host
    port = args.port or config.port
    debug = bool(args.debug or config.debug)
    app = create_socketio_asgi_app(config)

    log_level = "debug" if debug else "info"
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=log_level,
    )


if __name__ == "__main__":
    main()
