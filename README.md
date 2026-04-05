## Arcaptcha

Arcaptcha is a daily browser microgame built on top of ARC-AGI-3 public environments.
The player gets a mystery grid, no instructions, and a centered handheld-console UI. The current implementation is a vertical slice:

- A Python backend that extends the ARC-AGI toolkit REST server.
- A daily catalog that rotates the official public ARC-AGI-3 game pool in replay seasons.
- A React frontend with a canvas-rendered grid, handheld-style controls, and anonymous local session identity.

## Stack

- Python 3.12
- `arc-agi` toolkit for environment loading and action execution
- Flask via the toolkit server app factory
- React + Vite for the browser UI

## Run locally

### Backend

Install Python dependencies and start the API server:

```bash
uv sync
uv run arcaptcha serve --debug
```

The backend defaults to `http://127.0.0.1:8000`.

### Frontend

Install the web dependencies and start the Vite dev server:

```bash
cd web
npm install
npm run dev
```

The frontend defaults to `http://127.0.0.1:5173` and proxies `/api` to the backend.

## Useful commands

Print the currently scheduled puzzle:

```bash
uv run arcaptcha daily
```

Build the frontend for the Flask app to serve:

```bash
cd web
npm run build
```

After the frontend build finishes, the backend serves `web/dist` at `/`.

## Runtime behavior

- The daily schedule is anchored to `2026-04-04` by default.
- Rotation uses the 25 public ARC-AGI-3 demo environments listed in `arcaptcha/content/games.json`.
- When the pool wraps, the schedule marks the day as replay-season content instead of pretending it is novel.
- The browser keeps only an anonymous API key in `localStorage` for stable local sessions.
- The exact reference action count is hidden until the post-rollover reveal window.

## Important caveats

- This repo currently uses the official public ARC-AGI-3 environment pool directly.
- The reference action count still falls back to toolkit baseline actions unless a curated value is added to `arcaptcha/content/games.json`.
- No accounts, monetization, or leaderboard logic are included in this version.
