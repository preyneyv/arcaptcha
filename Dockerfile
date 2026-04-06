FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
	PYTHONUNBUFFERED=1 \
	UV_LINK_MODE=copy \
	UV_COMPILE_BYTECODE=1 \
	PATH="/app/.venv/bin:$PATH" \
	PORT=5000

WORKDIR /app

COPY pyproject.toml uv.lock ./

RUN uv sync --frozen --no-dev --no-install-project

COPY arcaptcha ./arcaptcha
COPY environment_files ./environment_files
COPY web ./web

WORKDIR /app/arcaptcha

EXPOSE 5000

CMD ["sh", "-c", "waitress-serve --host=0.0.0.0 --port=${PORT} --call app:create_app"]
