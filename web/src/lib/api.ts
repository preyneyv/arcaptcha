import { getOrCreatePlayerId } from "./storage";

export class ApiRequestError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export type ActionName =
  | "RESET" // reset
  | "ACTION1" // up
  | "ACTION2" // down
  | "ACTION3" // left
  | "ACTION4" // right
  | "ACTION5" // use
  | "ACTION6" // click
  | "ACTION7" // undo
  | "HELP"; // help

export type GameplayActionName = Exclude<ActionName, "HELP">;

export type GameState = "NOT_PLAYED" | "NOT_FINISHED" | "WIN" | "GAME_OVER";

export interface ReplayActionEntry {
  action: GameplayActionName;
  x?: number;
  y?: number;
}

export interface DailyPuzzle {
  date: string;
  gameId: string;
  resolvedGameId: string;
  baselineActions: number[] | null;
}

export interface CommandFrame {
  gameId: string;
  state: GameState;
  moveHash?: string;
  levelsCompleted: number;
  winLevels: number;
  fullReset: boolean;
  availableActions: ActionName[];
  frame: number[][][];
  grid: number[][];
}

export interface BootstrappedSession {
  daily: DailyPuzzle;
  frame: CommandFrame;
}

const ACTION_NAMES_BY_CODE: Record<number, ActionName> = {
  0: "RESET",
  1: "ACTION1",
  2: "ACTION2",
  3: "ACTION3",
  4: "ACTION4",
  5: "ACTION5",
  6: "ACTION6",
  7: "ACTION7",
};

interface RawDailyPuzzle {
  date: string;
  game_id: string;
  resolved_game_id: string;
  baseline_actions: number[] | null;
}

interface RawCommandFrame {
  game_id: string;
  state: GameState;
  move_hash?: string;
  levels_completed: number;
  win_levels: number;
  full_reset: boolean;
  available_actions: number[];
  frame: number[][][];
}

type RawBootstrapPayload = RawDailyPuzzle & RawCommandFrame;

const API_ROOT = normalizeApiRoot(import.meta.env.VITE_API_ROOT);

interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
  keepalive?: boolean;
}

function formatDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

export function getSelectedEditionDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${formatDatePart(now.getMonth() + 1)}-${formatDatePart(now.getDate())}`;
}

function resolveEditionDate(editionDate?: string | null): string {
  return editionDate || getSelectedEditionDate();
}

function normalizeApiRoot(raw: string | undefined): string {
  if (!raw) {
    return "";
  }

  return raw.trim().replace(/\/+$/, "");
}

function buildApiUrl(path: string): string {
  return API_ROOT ? `${API_ROOT}${path}` : path;
}

function buildHeaders(initHeaders?: HeadersInit): Headers {
  const headers = new Headers(initHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("X-API-Key", getOrCreatePlayerId());
  return headers;
}

async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    method: options.method ?? "GET",
    headers: buildHeaders(options.headers),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    keepalive: options.keepalive,
  });

  return readJson<T>(response);
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();

    if (text) {
      try {
        const payload = JSON.parse(text) as {
          error?: unknown;
          message?: unknown;
        };
        const message =
          typeof payload.message === "string" && payload.message
            ? payload.message
            : text;
        const code = typeof payload.error === "string" ? payload.error : null;
        throw new ApiRequestError(message, response.status, code);
      } catch (error) {
        if (error instanceof ApiRequestError) {
          throw error;
        }
      }
    }

    throw new ApiRequestError(
      text || `Request failed with ${response.status}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

function mapDailyPuzzle(raw: RawDailyPuzzle): DailyPuzzle {
  return {
    date: raw.date,
    gameId: raw.game_id,
    resolvedGameId: raw.resolved_game_id,
    baselineActions: raw.baseline_actions,
  };
}

function extractGrid(frame: number[][][]): number[][] {
  if (!Array.isArray(frame) || frame.length === 0) {
    return [];
  }

  return frame[frame.length - 1] ?? [];
}

function mapFrame(raw: RawCommandFrame): CommandFrame {
  return {
    gameId: raw.game_id,
    state: raw.state,
    moveHash:
      typeof raw.move_hash === "string" && raw.move_hash
        ? raw.move_hash
        : undefined,
    levelsCompleted: raw.levels_completed,
    winLevels: raw.win_levels,
    fullReset: raw.full_reset,
    availableActions: raw.available_actions
      .map((actionCode) => ACTION_NAMES_BY_CODE[actionCode])
      .filter(Boolean),
    frame: raw.frame,
    grid: extractGrid(raw.frame),
  };
}

export async function bootstrapDailySession(
  options: {
    editionDate?: string | null;
    replayActions?: ReplayActionEntry[];
  } = {},
): Promise<BootstrappedSession> {
  const payload: Record<string, unknown> = {
    edition_date: resolveEditionDate(options.editionDate),
  };
  if (options.replayActions && options.replayActions.length > 0) {
    payload.replay_actions = options.replayActions;
  }

  const raw = await apiRequest<RawBootstrapPayload>(
    "/api/arcaptcha/bootstrap",
    {
      method: "POST",
      body: payload,
    },
  );
  return {
    daily: mapDailyPuzzle(raw),
    frame: mapFrame(raw),
  };
}

export async function sendAction(
  action: GameplayActionName,
  extraData: Record<string, unknown> = {},
  options: {
    editionDate?: string | null;
    moveHash?: string;
  } = {},
): Promise<CommandFrame> {
  const payload: Record<string, unknown> = {
    action,
    edition_date: resolveEditionDate(options.editionDate),
    ...extraData,
  };

  if (typeof options.moveHash === "string" && options.moveHash) {
    payload.move_hash = options.moveHash;
  }

  return mapFrame(
    await apiRequest<RawCommandFrame>("/api/arcaptcha/action", {
      method: "POST",
      body: payload,
    }),
  );
}

export async function unloadDailySession(
  editionDate?: string | null,
): Promise<void> {
  await apiRequest<{ status: string }>("/api/arcaptcha/unload", {
    method: "POST",
    body: {
      edition_date: resolveEditionDate(editionDate),
    },
  });
}

export function keepAliveUnloadDailySession(editionDate?: string | null): void {
  const payload = JSON.stringify({
    edition_date: resolveEditionDate(editionDate),
    api_key: getOrCreatePlayerId(),
  });

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.sendBeacon === "function"
  ) {
    const accepted = navigator.sendBeacon(
      buildApiUrl("/api/arcaptcha/unload"),
      new Blob([payload], { type: "application/json" }),
    );
    if (accepted) {
      return;
    }
  }

  void fetch(buildApiUrl("/api/arcaptcha/unload"), {
    method: "POST",
    headers: buildHeaders(),
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Ignore best-effort unload failures.
  });
}

export function isSessionMissingError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }

  return error.code === "SESSION_MISSING" || error.status === 404;
}
