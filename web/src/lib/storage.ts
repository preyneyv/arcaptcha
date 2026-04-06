import type { ActionName } from "./api";

export interface PlayerStore {
  version: 2;
  apiKey: string;
}

export type PersistedRunStatus = "in_progress" | "completed";

export interface PersistedRunSessionState {
  cardId: string;
  gameId: string;
  guid: string | null;
  state: string;
  availableActions: ActionName[];
  grid: number[][];
  countedActions: number;
  levelsCompleted: number;
  winLevels: number;
  levelActionCounts: number[];
  currentLevelStartActionCount: number;
}

export interface PersistedRunState {
  version: 1;
  dailyDate: string;
  status: PersistedRunStatus;
  session: PersistedRunSessionState;
  completedAt?: string;
}

const STORAGE_KEY = "arcaptcha.v2";
const LEGACY_STORAGE_KEY = "arcaptcha.v1";
const RUN_STORAGE_KEY = "arcaptcha.run.v1";
const ALLOWED_ACTIONS: readonly ActionName[] = [
  "RESET",
  "ACTION1",
  "ACTION2",
  "ACTION3",
  "ACTION4",
  "ACTION5",
  "ACTION6",
  "ACTION7",
  "HELP",
];

function defaultStore(): PlayerStore {
  return {
    version: 2,
    apiKey: "",
  };
}

function safeParse(raw: string | null): PlayerStore | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { apiKey?: unknown; version?: unknown };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      version: 2,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    return null;
  }
}

function writeStore(store: PlayerStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

function toNonNegativeInt(value: unknown, fallback: number = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

function parseAvailableActions(raw: unknown): ActionName[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const allowed = new Set(ALLOWED_ACTIONS);
  return raw
    .filter((value): value is string => typeof value === "string")
    .filter((value): value is ActionName => allowed.has(value as ActionName));
}

function parsePersistedGrid(raw: unknown): number[][] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => toNonNegativeInt(cell, 0)));
}

function parseRunSession(raw: unknown): PersistedRunSessionState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  if (typeof source.cardId !== "string" || !source.cardId) {
    return null;
  }

  if (typeof source.gameId !== "string" || !source.gameId) {
    return null;
  }

  const guid = typeof source.guid === "string" ? source.guid : null;
  const state =
    typeof source.state === "string" && source.state ? source.state : "RUNNING";
  const availableActions = parseAvailableActions(source.availableActions);
  const grid = parsePersistedGrid(source.grid);
  const countedActions = Math.max(
    1,
    toNonNegativeInt(source.countedActions, 1),
  );
  const levelsCompleted = toNonNegativeInt(source.levelsCompleted, 0);
  const winLevels = Math.max(1, toNonNegativeInt(source.winLevels, 1));
  const rawLevelActionCounts = Array.isArray(source.levelActionCounts)
    ? source.levelActionCounts
    : [];
  const levelActionCounts = rawLevelActionCounts
    .map((value) => toNonNegativeInt(value, 0))
    .slice(0, levelsCompleted);
  const currentLevelStartActionCount = Math.min(
    countedActions,
    toNonNegativeInt(source.currentLevelStartActionCount, countedActions),
  );

  return {
    cardId: source.cardId,
    gameId: source.gameId,
    guid,
    state,
    availableActions,
    grid,
    countedActions,
    levelsCompleted,
    winLevels,
    levelActionCounts,
    currentLevelStartActionCount,
  };
}

function safeParseRun(raw: string | null): PersistedRunState | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (typeof parsed.dailyDate !== "string" || !parsed.dailyDate) {
      return null;
    }

    const status =
      parsed.status === "in_progress" || parsed.status === "completed"
        ? parsed.status
        : null;
    if (!status) {
      return null;
    }

    const session = parseRunSession(parsed.session);
    if (!session) {
      return null;
    }

    const completedAt =
      typeof parsed.completedAt === "string" && parsed.completedAt
        ? parsed.completedAt
        : undefined;

    return {
      version: 1,
      dailyDate: parsed.dailyDate,
      status,
      session,
      completedAt,
    };
  } catch {
    return null;
  }
}

function createAnonymousKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `human-${crypto.randomUUID()}`;
  }

  return `human-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function readStore(): PlayerStore {
  return (
    safeParse(localStorage.getItem(STORAGE_KEY)) ??
    safeParse(localStorage.getItem(LEGACY_STORAGE_KEY)) ??
    defaultStore()
  );
}

export function getOrCreatePlayerId(): string {
  const store = readStore();
  if (!store.apiKey) {
    const nextStore = {
      ...store,
      apiKey: createAnonymousKey(),
    } satisfies PlayerStore;
    writeStore(nextStore);
    return nextStore.apiKey;
  }

  if (store.version !== 2) {
    writeStore(store);
  }

  return store.apiKey;
}

export function readPersistedRunState(): PersistedRunState | null {
  return safeParseRun(localStorage.getItem(RUN_STORAGE_KEY));
}

export function writePersistedRunState(state: PersistedRunState): void {
  localStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(state));
}

export function clearPersistedRunState(): void {
  localStorage.removeItem(RUN_STORAGE_KEY);
}
