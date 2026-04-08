## ARCaptcha

![ARCaptcha](./web/public/sm_image.png)

ARCaptcha is a daily browser puzzle built on top of [ARC-AGI-3](https://arcprize.org/arc-agi/3). The repo has two main parts:

- A Python backend that serves one daily puzzle at a time, keeps live environments in memory, evicts stale sessions, and can download missing daily environments from the ARC servers on demand.
- A React and Vite frontend that renders the handheld console UI and stores anonymous browser identity, replay actions, and same-day run state in `localStorage`.

> [!WARNING]
> Parts of this codebase are pretty scuffed and need some tidying. At the moment, my goal is just to get a v1 out there.

## Repo Layout

- `arcaptcha/` backend Flask app, CLI, config, catalog logic, and an alternate fuller Dockerfile.
- `web/` frontend source, Vite config, and built static assets.
- `Dockerfile` root-level container build for a minimal API image.

## Runtime Model

- The backend no longer exposes the generic ARC scorecard or `/api/cmd/*` routes.
- The browser uses an anonymous `X-API-Key` stored in `localStorage` as a lightweight per-browser identity.
- The primary gameplay flow is `POST /api/arcaptcha/bootstrap`, `POST /api/arcaptcha/action`, and `POST /api/arcaptcha/unload`.
- The browser selects one edition date from its local calendar day and sends that `edition_date` on bootstrap, action, and unload requests.
- The backend accepts only the latest globally available edition date relative to `UTC+14` and the immediately previous one, so all local timezones map onto a valid playable edition.
- `bootstrap` returns both the selected daily metadata and the current game frame, and it keeps the environment warm by reusing or creating the live in-memory session for that edition date.
- If the current daily environment is not present under `environment_files/`, the backend downloads its metadata and source code from the ARC servers during bootstrap.
- No backend user accounts or durable user progress are stored. Refresh and restart recovery comes from the browser replay log in `localStorage`.

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

The daily schedule is frozen from the checked-in [arcaptcha/content/games.json](arcaptcha/content/games.json). The backend does not refetch or rewrite the catalog at startup, but it still downloads a specific environment on demand when bootstrap needs a missing daily.

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

Inspect a specific currently playable edition:

```bash
cd arcaptcha
uv run python cli.py daily --edition-date 2026-04-07
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

- `ARC_BASE_URL` configures the upstream ARC API origin. Defaults to `https://three.arcprize.org`.
- `ARC_API_KEY` configures the upstream ARC API key. If unset, the backend requests an anonymous key when it needs one.
- `ARCAPTCHA_SESSION_TTL_SECONDS` controls how long an idle in-memory daily session stays warm before cleanup. Defaults to `900`.
- `ARCAPTCHA_ARC_REQUEST_TIMEOUT_SECONDS` controls ARC metadata and source download timeouts. Defaults to `10`.
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
