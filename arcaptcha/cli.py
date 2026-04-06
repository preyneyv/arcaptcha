from __future__ import annotations

import argparse
import json
import logging
from datetime import datetime, timezone
from typing import Sequence

from arc_agi import Arcade

from .app import create_app
from .catalog import GameCatalog
from .config import AppConfig

LOGGER = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="arcaptcha")
    subparsers = parser.add_subparsers(dest="command")

    serve_parser = subparsers.add_parser("serve", help="run the Arcaptcha server")
    serve_parser.add_argument("--host")
    serve_parser.add_argument("--port", type=int)
    serve_parser.add_argument("--debug", action="store_true")

    subparsers.add_parser("daily", help="print the currently scheduled daily puzzle")
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command or "serve"

    config = AppConfig.from_env()

    if command == "daily":
        arcade = Arcade(
            operation_mode=config.operation_mode,
            environments_dir=str(config.environments_dir),
            recordings_dir=str(config.recordings_dir),
        )
        environments = ()
        try:
            environments = tuple(arcade.get_environments())
        except Exception as error:
            LOGGER.warning(
                "failed to fetch available games for daily output: %s", error
            )

        if environments:
            GameCatalog.write_from_environments(
                config.catalog_path,
                environments,
                season_name="arc-agi",
            )

        catalog = GameCatalog.load(config.catalog_path)
        now = datetime.now(timezone.utc)
        scheduled = catalog.current(now, config.season_start)
        environment = catalog.environment_index(environments).get(
            scheduled.entry.game_id
        )
        print(
            json.dumps(
                scheduled.to_payload(environment),
                indent=2,
            )
        )
        return

    host = args.host or config.host
    port = args.port or config.port
    debug = bool(args.debug or config.debug)
    app = create_app(config)

    if debug:
        app.run(host=host, port=port, debug=True, threaded=True)
        return

    from waitress import serve

    serve(app, host=host, port=port)


if __name__ == "__main__":
    main()
