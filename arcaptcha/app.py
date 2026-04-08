from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

import socketio
import zstandard as zstd
from asgiref.wsgi import WsgiToAsgi
from catalog import GameCatalog
from config import AppConfig
from daily_runtime import (
    ActionValidationError,
    DailyRuntimeManager,
    SessionMissingError,
    frame_to_payload,
    parse_action_request,
    parse_move_hash,
    parse_replay_actions,
)
from edition import EditionDateValidationError, resolve_edition_date
from environment_sync import EnvironmentSyncError, EnvironmentSyncService
from flask import Flask, Response, jsonify, redirect, request

LOGGER = logging.getLogger(__name__)

ALLOWED_CORS_HEADERS = "Content-Type, X-API-Key"
ALLOWED_CORS_METHODS = "GET, POST, OPTIONS"
SOCKET_NAMESPACE = "/arcaptcha"
SOCKET_IDLE_CHECK_SECONDS = 30
DEFAULT_DEV_ORIGINS = (
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:4173",
    "http://localhost:4173",
)

_cleanup_thread_lock = threading.Lock()
_socket_cleanup_task_lock = threading.Lock()


@dataclass(slots=True)
class SocketSessionBinding:
    api_key: str
    daily_date: str | None = None
    move_hash: str | None = None
    last_activity_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


def _socket_success(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "payload": payload,
    }


def _socket_error(
    code: str,
    message: str,
    status: int,
) -> dict[str, Any]:
    return {
        "ok": False,
        "error": code,
        "message": message,
        "status": status,
    }


def _expand_local_origin_aliases(origin: str) -> set[str]:
    parsed = urlsplit(origin)
    if not parsed.scheme or not parsed.hostname:
        return {origin}

    normalized_origin = f"{parsed.scheme}://{parsed.netloc}"
    aliases = {normalized_origin}
    port_suffix = f":{parsed.port}" if parsed.port is not None else ""

    if parsed.hostname == "localhost":
        aliases.add(f"{parsed.scheme}://127.0.0.1{port_suffix}")
    elif parsed.hostname == "127.0.0.1":
        aliases.add(f"{parsed.scheme}://localhost{port_suffix}")

    return aliases


def _build_allowed_origins(config: AppConfig) -> set[str]:
    base_origins = {
        origin.rstrip("/") for origin in config.cors_allowed_origins if origin.strip()
    }
    if config.frontend_dev_url:
        base_origins.add(config.frontend_dev_url.rstrip("/"))
    if config.debug:
        base_origins.update(DEFAULT_DEV_ORIGINS)

    expanded_origins: set[str] = set()
    for origin in base_origins:
        expanded_origins.update(_expand_local_origin_aliases(origin))

    return expanded_origins


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

    if config.force_game_id:
        LOGGER.warning(
            "force_game_id is set to '%s', overriding all catalog entries",
            config.force_game_id,
        )
        catalog = GameCatalog.from_entries([config.force_game_id])
    else:
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
    _register_response_compression(app)
    _register_api_routes(app, catalog, config)
    _register_frontend_routes(app, config)
    return app


def create_socketio_asgi_app(config: AppConfig | None = None) -> socketio.ASGIApp:
    config = config or AppConfig.from_env()
    app = create_app(config)
    allowed_origins = sorted(_build_allowed_origins(config))

    sio = socketio.AsyncServer(
        async_mode="asgi",
        cors_allowed_origins=allowed_origins,
        logger=False,
        engineio_logger=False,
    )

    _register_socket_routes(
        app,
        sio,
        config,
    )
    return socketio.ASGIApp(
        socketio_server=sio,
        other_asgi_app=WsgiToAsgi(app),
    )


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
    allowed_origins = _build_allowed_origins(config)

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


def _read_event_payload(raw: object) -> dict[str, object]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ActionValidationError("request body must be a JSON object")
    return raw


def _normalize_api_key(raw: object) -> str | None:
    if isinstance(raw, str):
        normalized = raw.strip()
        if normalized:
            return normalized
    return None


def _resolve_socket_api_key(auth: object, environ: dict[str, Any]) -> str:
    if isinstance(auth, dict):
        for key in ("api_key", "apiKey", "x-api-key"):
            api_key = _normalize_api_key(auth.get(key))
            if api_key:
                return api_key

    api_key_header = _normalize_api_key(environ.get("HTTP_X_API_KEY"))
    if api_key_header:
        return api_key_header
    return "anonymous"


def _register_socket_routes(
    app: Flask,
    sio: socketio.AsyncServer,
    config: AppConfig,
) -> None:
    runtime_manager: DailyRuntimeManager = app.extensions["arcaptcha"][
        "runtime_manager"
    ]
    catalog: GameCatalog = app.extensions["arcaptcha"]["catalog"]
    extension_state = app.extensions["arcaptcha"]
    socket_bindings: dict[str, SocketSessionBinding] = {}
    socket_bindings_lock = threading.Lock()
    extension_state["socket_bindings"] = socket_bindings
    extension_state["socket_bindings_lock"] = socket_bindings_lock
    extension_state["socket_idle_task_started"] = False

    def touch_socket_binding(
        sid: str,
        *,
        api_key: str | None = None,
        daily_date: str | None = None,
        move_hash: str | None = None,
        clear_session: bool = False,
    ) -> None:
        with socket_bindings_lock:
            binding = socket_bindings.get(sid)
            if binding is None:
                binding = SocketSessionBinding(api_key=api_key or "anonymous")
                socket_bindings[sid] = binding

            if api_key is not None:
                binding.api_key = api_key
            if clear_session:
                binding.daily_date = None
                binding.move_hash = None
            if daily_date is not None:
                binding.daily_date = daily_date
            if move_hash is not None:
                binding.move_hash = move_hash
            binding.last_activity_at = datetime.now(timezone.utc)

    def get_socket_binding(sid: str) -> SocketSessionBinding | None:
        with socket_bindings_lock:
            binding = socket_bindings.get(sid)
            if binding is None:
                return None
            return replace(binding)

    def pop_socket_binding(sid: str) -> SocketSessionBinding | None:
        with socket_bindings_lock:
            return socket_bindings.pop(sid, None)

    def resolve_binding_api_key(binding: SocketSessionBinding | None) -> str:
        if binding is None:
            return "anonymous"
        return binding.api_key

    def resolve_payload_edition_date(data: dict[str, object]):
        return resolve_edition_date(
            data.get("edition_date"),
            season_start=config.season_start,
            now=datetime.now(timezone.utc),
        )

    def destroy_bound_session(binding: SocketSessionBinding) -> None:
        if binding.daily_date is None:
            return

        runtime_manager.destroy_session(
            binding.api_key,
            binding.daily_date,
            binding.move_hash,
        )

    def socket_server_error(log_message: str, error: Exception) -> dict[str, Any]:
        LOGGER.exception(log_message)
        error_message = str(error) if config.debug else "internal server error"
        return _socket_error("SERVER_ERROR", error_message, 500)

    async def socket_idle_reaper_loop() -> None:
        idle_ttl = runtime_manager.session_ttl

        while True:
            await sio.sleep(SOCKET_IDLE_CHECK_SECONDS)
            now = datetime.now(timezone.utc)
            stale_bindings: list[tuple[str, SocketSessionBinding]] = []

            with socket_bindings_lock:
                for sid, binding in list(socket_bindings.items()):
                    if now - binding.last_activity_at < idle_ttl:
                        continue

                    stale_bindings.append((sid, binding))
                    socket_bindings.pop(sid, None)

            for sid, binding in stale_bindings:
                destroy_bound_session(binding)

                try:
                    await sio.disconnect(sid, namespace=SOCKET_NAMESPACE)
                except Exception:  # pragma: no cover - defensive socket shutdown
                    LOGGER.debug("socket %s already disconnected", sid)

    def ensure_socket_idle_task() -> None:
        with _socket_cleanup_task_lock:
            if extension_state.get("socket_idle_task_started"):
                return

            extension_state["socket_idle_task_started"] = True
            sio.start_background_task(socket_idle_reaper_loop)

    @sio.event(namespace=SOCKET_NAMESPACE)
    async def connect(sid: str, environ: dict[str, Any], auth: object) -> None:
        ensure_socket_idle_task()
        api_key = _resolve_socket_api_key(auth, environ)
        touch_socket_binding(
            sid,
            api_key=api_key,
        )

    @sio.event(namespace=SOCKET_NAMESPACE)
    async def disconnect(sid: str) -> None:
        binding = pop_socket_binding(sid)
        if binding is None:
            return

        destroy_bound_session(binding)

    @sio.event(namespace=SOCKET_NAMESPACE)
    async def bootstrap(sid: str, raw_payload: object) -> dict[str, Any]:
        try:
            data = _read_event_payload(raw_payload)
            edition_date = resolve_payload_edition_date(data)
            replay_actions = parse_replay_actions(data.get("replay_actions"))
        except (ActionValidationError, EditionDateValidationError) as error:
            return _socket_error("VALIDATION_ERROR", str(error), 400)

        scheduled = catalog.for_date(edition_date, config.season_start)
        binding = get_socket_binding(sid)
        api_key = resolve_binding_api_key(binding)
        try:
            environment, frame, move_hash = runtime_manager.bootstrap(
                api_key=api_key,
                daily_date=edition_date.isoformat(),
                game_id=scheduled.entry.game_id,
                replay_actions=replay_actions,
            )
        except EnvironmentSyncError as error:
            return _socket_error("ENVIRONMENT_SYNC_ERROR", str(error), 503)
        except Exception as error:  # pragma: no cover - defensive runtime fallback
            return socket_server_error(
                "failed to bootstrap daily environment over socket",
                error,
            )

        touch_socket_binding(
            sid,
            api_key=api_key,
            daily_date=edition_date.isoformat(),
            move_hash=move_hash,
        )

        payload = scheduled.to_payload(environment)
        payload.update(frame_to_payload(environment, frame, move_hash=move_hash))
        return _socket_success(payload)

    @sio.event(namespace=SOCKET_NAMESPACE)
    async def action(sid: str, raw_payload: object) -> dict[str, Any]:
        try:
            data = _read_event_payload(raw_payload)
            action = parse_action_request(data)
            expected_move_hash = parse_move_hash(data.get("move_hash"))
            edition_date = resolve_payload_edition_date(data)
        except (ActionValidationError, EditionDateValidationError) as error:
            return _socket_error("VALIDATION_ERROR", str(error), 400)

        binding = get_socket_binding(sid)
        api_key = resolve_binding_api_key(binding)
        try:
            environment, frame, move_hash = runtime_manager.apply_action(
                api_key=api_key,
                daily_date=edition_date.isoformat(),
                expected_move_hash=expected_move_hash,
                action=action,
            )
        except SessionMissingError as error:
            return _socket_error("SESSION_MISSING", str(error), 404)
        except Exception as error:  # pragma: no cover - defensive runtime fallback
            return socket_server_error(
                "failed to apply daily action over socket",
                error,
            )

        touch_socket_binding(
            sid,
            api_key=api_key,
            daily_date=edition_date.isoformat(),
            move_hash=move_hash,
        )
        return _socket_success(
            frame_to_payload(environment, frame, move_hash=move_hash)
        )

    @sio.event(namespace=SOCKET_NAMESPACE)
    async def unload(sid: str, raw_payload: object) -> dict[str, Any]:
        try:
            data = _read_event_payload(raw_payload)
            edition_date = resolve_payload_edition_date(data)
        except (ActionValidationError, EditionDateValidationError) as error:
            return _socket_error("VALIDATION_ERROR", str(error), 400)

        binding = get_socket_binding(sid)
        api_key = resolve_binding_api_key(binding)
        daily_date = edition_date.isoformat()
        destroyed = runtime_manager.destroy_session(
            api_key,
            daily_date,
            binding.move_hash
            if binding is not None and binding.daily_date == daily_date
            else None,
        )
        touch_socket_binding(
            sid,
            api_key=api_key,
            clear_session=True,
        )
        return _socket_success({"status": "ok", "destroyed": destroyed})


def _request_accepts_content_encoding(encoding_name: str) -> bool:
    accept_encoding = request.headers.get("Accept-Encoding", "")
    if not accept_encoding:
        return False

    qualities: dict[str, float] = {}
    for encoding in accept_encoding.split(","):
        token, *params = encoding.split(";")
        normalized = token.strip().lower()
        if not normalized:
            continue

        quality = 1.0
        for raw_param in params:
            key, sep, value = raw_param.strip().partition("=")
            if key.strip().lower() != "q" or not sep:
                continue
            try:
                quality = float(value)
            except ValueError:
                quality = 0.0
            break
        qualities[normalized] = quality

    normalized_encoding_name = encoding_name.strip().lower()
    if normalized_encoding_name in qualities:
        return qualities[normalized_encoding_name] > 0
    if "*" in qualities:
        return qualities["*"] > 0
    return False


def _register_response_compression(app: Flask) -> None:
    @app.after_request
    def maybe_zstd_json_response(response: Response) -> Response:
        if request.method == "HEAD" or not request.path.startswith("/api/"):
            return response
        if response.direct_passthrough or response.is_streamed:
            return response

        mimetype = (response.mimetype or "").lower()
        if mimetype != "application/json" and not mimetype.endswith("+json"):
            return response
        if response.headers.get("Content-Encoding"):
            return response
        if not _request_accepts_content_encoding("zstd"):
            return response

        payload = response.get_data()
        if not payload:
            return response

        compressed_payload = zstd.ZstdCompressor(level=3).compress(payload)
        response.set_data(compressed_payload)
        response.headers["Content-Encoding"] = "zstd"
        response.headers["Content-Length"] = str(len(compressed_payload))
        response.vary.add("Accept-Encoding")
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
            environment, frame, move_hash = runtime_manager.bootstrap(
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
        payload.update(frame_to_payload(environment, frame, move_hash=move_hash))
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
            expected_move_hash = parse_move_hash(data.get("move_hash"))
            edition_date = resolve_edition_date(
                data.get("edition_date"),
                season_start=config.season_start,
                now=now,
            )
        except (ActionValidationError, EditionDateValidationError) as error:
            return _validation_error_response(str(error))

        api_key = request.headers.get("X-API-Key", "anonymous")
        try:
            environment, frame, move_hash = runtime_manager.apply_action(
                api_key=api_key,
                daily_date=edition_date.isoformat(),
                expected_move_hash=expected_move_hash,
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

        return jsonify(frame_to_payload(environment, frame, move_hash=move_hash))

    @app.post("/api/arcaptcha/unload")
    def arcaptcha_unload() -> Response | tuple[Response, int]:
        runtime_manager: DailyRuntimeManager = app.extensions["arcaptcha"][
            "runtime_manager"
        ]
        try:
            data = _read_request_body()
            edition_date = resolve_edition_date(
                data.get("edition_date"),
                season_start=config.season_start,
                now=datetime.now(timezone.utc),
            )
        except (ActionValidationError, EditionDateValidationError) as error:
            return _validation_error_response(str(error))

        api_key = request.headers.get("X-API-Key")
        if not api_key:
            body_api_key = data.get("api_key")
            if isinstance(body_api_key, str):
                api_key = body_api_key.strip() or None

        if not api_key:
            api_key = "anonymous"

        destroyed = runtime_manager.destroy_session(
            api_key,
            edition_date.isoformat(),
        )
        return jsonify({"status": "ok", "destroyed": destroyed})


def _register_frontend_routes(app: Flask, config: AppConfig) -> None:
    @app.get("/")
    def frontend_index():
        return redirect("https://arcaptcha.io", code=307)
