import { io, type Socket } from "socket.io-client";
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
type SocketEventName = "bootstrap" | "action" | "unload";

const API_ROOT = normalizeApiRoot(import.meta.env.VITE_API_ROOT);
const SOCKET_NAMESPACE = "/arcaptcha";
const SOCKET_PATH = "/socket.io";
const SOCKET_ACK_TIMEOUT_MS = 10000;

let socketClient: Socket | null = null;
let socketConnectPromise: Promise<Socket> | null = null;

function formatDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

export function getSelectedEditionDate(now: Date = new Date()): string {
  return `${now.getFullYear()}-${formatDatePart(now.getMonth() + 1)}-${formatDatePart(now.getDate())}`;
}

function resolveEditionDate(editionDate?: string | null): string {
  return editionDate || getSelectedEditionDate();
}

function buildEditionDatePayload(editionDate?: string | null): {
  edition_date: string;
} {
  return {
    edition_date: resolveEditionDate(editionDate),
  };
}

function normalizeApiRoot(raw: string | undefined): string {
  if (!raw) {
    return "";
  }

  return raw.trim().replace(/\/+$/, "");
}

function resolveSocketNamespaceUrl(): string {
  if (!API_ROOT) {
    return SOCKET_NAMESPACE;
  }

  try {
    const baseUrl =
      typeof window === "undefined"
        ? new URL(API_ROOT)
        : new URL(API_ROOT, window.location.origin);
    return `${baseUrl.origin}${SOCKET_NAMESPACE}`;
  } catch {
    return SOCKET_NAMESPACE;
  }
}

function getSocketClient(): Socket {
  if (socketClient) {
    return socketClient;
  }

  socketClient = io(resolveSocketNamespaceUrl(), {
    path: SOCKET_PATH,
    autoConnect: false,
    reconnection: false,
    transports: ["websocket", "polling"],
    auth: buildSocketAuth(),
  });

  return socketClient;
}

function toApiRequestError(
  error: unknown,
  fallbackStatus: number,
): ApiRequestError {
  if (error instanceof ApiRequestError) {
    return error;
  }

  if (error instanceof Error && error.message) {
    return new ApiRequestError(error.message, fallbackStatus);
  }

  return new ApiRequestError("Socket request failed", fallbackStatus);
}

function buildSocketAuth(): { api_key: string } {
  return {
    api_key: getOrCreatePlayerId(),
  };
}

function parseSocketEnvelope<T>(raw: unknown): T {
  if (!raw || typeof raw !== "object") {
    throw new ApiRequestError("Invalid socket response", 500);
  }

  const envelope = raw as Record<string, unknown>;
  if (envelope.ok === true) {
    return envelope.payload as T;
  }

  const message =
    typeof envelope.message === "string" && envelope.message
      ? envelope.message
      : "Socket request failed";
  const status =
    typeof envelope.status === "number" && Number.isFinite(envelope.status)
      ? envelope.status
      : 500;
  const code = typeof envelope.error === "string" ? envelope.error : null;
  throw new ApiRequestError(message, status, code);
}

async function ensureSocketConnected(): Promise<Socket> {
  const client = getSocketClient();
  if (client.connected) {
    return client;
  }

  if (socketConnectPromise) {
    return socketConnectPromise;
  }

  socketConnectPromise = new Promise<Socket>((resolve, reject) => {
    const handleConnect = () => {
      cleanup();
      resolve(client);
    };

    const handleConnectError = (error: Error) => {
      cleanup();
      reject(toApiRequestError(error, 503));
    };

    const cleanup = () => {
      client.off("connect", handleConnect);
      client.off("connect_error", handleConnectError);
    };

    client.auth = buildSocketAuth();
    client.on("connect", handleConnect);
    client.on("connect_error", handleConnectError);
    client.connect();
  });

  try {
    return await socketConnectPromise;
  } finally {
    socketConnectPromise = null;
  }
}

async function socketRequest<TResult>(
  eventName: SocketEventName,
  payload: Record<string, unknown>,
): Promise<TResult> {
  const client = await ensureSocketConnected();

  try {
    const rawResponse = await client
      .timeout(SOCKET_ACK_TIMEOUT_MS)
      .emitWithAck(eventName, payload);
    return parseSocketEnvelope<TResult>(rawResponse);
  } catch (error) {
    throw toApiRequestError(error, 503);
  }
}

function isActionName(action: ActionName | undefined): action is ActionName {
  return action !== undefined;
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
      .filter(isActionName),
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
  const payload: Record<string, unknown> = buildEditionDatePayload(
    options.editionDate,
  );
  if (options.replayActions && options.replayActions.length > 0) {
    payload.replay_actions = options.replayActions;
  }

  const raw = await socketRequest<RawBootstrapPayload>("bootstrap", payload);
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
    ...buildEditionDatePayload(options.editionDate),
    ...extraData,
  };

  if (typeof options.moveHash === "string" && options.moveHash) {
    payload.move_hash = options.moveHash;
  }

  return mapFrame(await socketRequest<RawCommandFrame>("action", payload));
}

export async function unloadDailySession(
  editionDate?: string | null,
): Promise<void> {
  await socketRequest<{ status: string }>(
    "unload",
    buildEditionDatePayload(editionDate),
  );
}

export function keepAliveUnloadDailySession(editionDate?: string | null): void {
  const client = socketClient;
  if (!client) {
    return;
  }

  const payload = buildEditionDatePayload(editionDate);

  if (client.connected) {
    client.emit("unload", payload);
  }

  client.disconnect();
}

export function isSessionMissingError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }

  return error.code === "SESSION_MISSING" || error.status === 404;
}
