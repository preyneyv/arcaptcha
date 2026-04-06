## ARCaptcha

![ARCaptcha](./web/public/sm_image.png)

ARCaptcha is a daily browser puzzle built on top of [ARC-AGI-3](https://arcprize.org/arc-agi/3). The repo has two main parts:

- A Python backend that mounts the ARC toolkit REST API, serves the current daily puzzle, and runs scorecard cleanup in-process.
- A React and Vite frontend that renders the handheld console UI and stores anonymous player identity plus best-effort run state in `localStorage`.

> [!WARNING]
> Parts of this codebase are pretty scuffed and need some tidying. At the moment, my goal is just to get a v1 out there.

## Repo Layout

- `arcaptcha/` backend Flask app, CLI, config, catalog logic, and an alternate fuller Dockerfile.
- `web/` frontend source, Vite config, and built static assets.
- `Dockerfile` root-level container build for a minimal API image.

## Requirements

- Python 3.12
- Node.js 20+
- `uv`
- `npm`

## Local Development

### Python Dependencies

```bash
uv sync
```

### Backend

The current backend entrypoints use module-local imports, so run backend commands from the `arcaptcha/` directory.

```bash
cd arcaptcha
uv run python cli.py serve --debug --host 127.0.0.1 --port 8000
```

The backend defaults to `http://127.0.0.1:8000`.

### Frontend

```bash
cd web
npm install
npm run dev
```

The frontend defaults to `http://127.0.0.1:5173` and proxies relative `/api` requests to `http://127.0.0.1:8000`.

## Utility Commands

Print the currently scheduled puzzle:

```bash
cd arcaptcha
uv run python cli.py daily
```

Print the current season as one JSON document:

```bash
cd arcaptcha
uv run python cli.py season
```

Build the frontend for Flask to serve:

```bash
cd web
npm run build
```

After a successful frontend build, the backend serves `web/dist` at `/`.

## Environment Variables

- `VITE_API_ROOT` changes the frontend API origin at build or dev time. If unset, the frontend uses relative `/api` URLs.

Example frontend override:

```bash
cd web
VITE_API_ROOT=http://localhost:5000 npm run dev
```

## Docker

### Minimal API Image

The root [Dockerfile](Dockerfile) builds a minimal API image and starts the backend with Waitress on port `5000`.

```bash
docker build -t arcaptcha/api .
docker run --rm -p 5000:5000 arcaptcha/api
```
