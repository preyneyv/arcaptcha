import { getOrCreatePlayerId } from "./storage";

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

export interface DailyPuzzle {
  date: string;
  gameId: string;
  resolvedGameId: string;
  title: string;
  cycle: number;
  dayIndex: number;
  isReplay: boolean;
  isAvailable: boolean;
  seasonName: string;
  revealAt: string;
  referenceRevealed: boolean;
  referenceActionCount: number | null;
  referenceSource: string;
  tags: string[];
}

export interface CommandFrame {
  gameId: string;
  state: string;
  levelsCompleted: number;
  winLevels: number;
  guid: string | null;
  fullReset: boolean;
  availableActions: ActionName[];
  frame: number[][][];
  grid: number[][];
}

export interface PlaySession {
  cardId: string;
  gameId: string;
  guid: string | null;
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
  title: string;
  cycle: number;
  day_index: number;
  is_replay: boolean;
  is_available: boolean;
  season_name: string;
  reveal_at: string;
  reference_revealed: boolean;
  reference_action_count: number | null;
  reference_source: string;
  tags: string[];
}

interface RawCommandFrame {
  game_id: string;
  state: string;
  levels_completed: number;
  win_levels: number;
  guid: string | null;
  full_reset: boolean;
  available_actions: number[];
  frame: number[][][];
}

function buildHeaders(initHeaders?: HeadersInit): Headers {
  const headers = new Headers(initHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("X-API-Key", getOrCreatePlayerId());
  return headers;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function mapDailyPuzzle(raw: RawDailyPuzzle): DailyPuzzle {
  return {
    date: raw.date,
    gameId: raw.game_id,
    resolvedGameId: raw.resolved_game_id,
    title: raw.title,
    cycle: raw.cycle,
    dayIndex: raw.day_index,
    isReplay: raw.is_replay,
    isAvailable: raw.is_available,
    seasonName: raw.season_name,
    revealAt: raw.reveal_at,
    referenceRevealed: raw.reference_revealed,
    referenceActionCount: raw.reference_action_count,
    referenceSource: raw.reference_source,
    tags: raw.tags,
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
    levelsCompleted: raw.levels_completed,
    winLevels: raw.win_levels,
    guid: raw.guid,
    fullReset: raw.full_reset,
    availableActions: raw.available_actions
      .map((actionCode) => ACTION_NAMES_BY_CODE[actionCode])
      .filter(Boolean),
    frame: raw.frame,
    grid: extractGrid(raw.frame),
  };
}

export async function fetchDailyPuzzle(): Promise<DailyPuzzle> {
  const response = await fetch("/api/arcaptcha/daily", {
    headers: buildHeaders(),
  });
  return mapDailyPuzzle(await readJson<RawDailyPuzzle>(response));
}

export async function openScorecard(): Promise<{ cardId: string }> {
  const response = await fetch("/api/scorecard/open", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      tags: ["human", "web"],
      source_url: window.location.origin,
    }),
  });
  const payload = await readJson<{ card_id: string }>(response);
  return { cardId: payload.card_id };
}

export async function sendAction(
  action: ActionName,
  session: PlaySession,
  extraData: Record<string, unknown> = {},
): Promise<CommandFrame> {
  const payload: Record<string, unknown> = {
    game_id: session.gameId,
    card_id: session.cardId,
    ...extraData,
  };

  if (action !== "RESET" && session.guid) {
    payload.guid = session.guid;
  }

  const response = await fetch(`/api/cmd/${action}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });
  return mapFrame(await readJson<RawCommandFrame>(response));
}

export async function openPlaySession(gameId: string): Promise<{
  session: PlaySession;
  frame: CommandFrame;
}> {
  const scorecard = await openScorecard();
  const frame = await sendAction("RESET", {
    cardId: scorecard.cardId,
    gameId,
    guid: null,
  });

  return {
    session: {
      cardId: scorecard.cardId,
      gameId: frame.gameId,
      guid: frame.guid,
    },
    frame,
  };
}
