import {
  getSelectedEditionDate,
  type ActionName,
  type BootstrappedSession,
  type CommandFrame,
  type DailyPuzzle,
  type GameState,
  type GameplayActionName,
} from "../lib/api";
import {
  clearPersistedRunState,
  readPersistedRunState,
  writePersistedRunState,
  type PersistedActionLogEntry,
  type PersistedRunSessionState,
} from "../lib/storage";

type BackendActionName = GameplayActionName;

const GAME_STATES: readonly GameState[] = [
  "NOT_PLAYED",
  "NOT_FINISHED",
  "WIN",
  "GAME_OVER",
] as const;

export interface RuntimeSession {
  gameId: string;
  state: GameState;
  frames: number[][][];
  grid: number[][];
  availableActions: ActionName[];
  countedActions: number;
  levelsCompleted: number;
  winLevels: number;
  levelActionCounts: number[];
  currentLevelStartActionCount: number;
  actionLog: PersistedActionLogEntry[];
}

export type SessionMetricsSeed =
  | Pick<
      RuntimeSession,
      "countedActions" | "levelActionCounts" | "currentLevelStartActionCount"
    >
  | Pick<
      PersistedRunSessionState,
      "countedActions" | "levelActionCounts" | "currentLevelStartActionCount"
    >
  | null;

export interface GameEnvironmentApi {
  bootstrapDailySession(options?: {
    editionDate?: string | null;
    replayActions?: PersistedActionLogEntry[];
  }): Promise<BootstrappedSession>;
  sendAction(
    action: BackendActionName,
    extraData?: Record<string, unknown>,
    options?: {
      editionDate?: string | null;
    },
  ): Promise<CommandFrame>;
  unloadDailySession(editionDate?: string | null): Promise<void>;
}

export interface SessionChange {
  previousSession: RuntimeSession | null;
  session: RuntimeSession | null;
}

export interface ActiveSessionChange {
  previousSession: RuntimeSession | null;
  session: RuntimeSession;
}

export interface StartSessionOptions {
  editionDate?: string | null;
  replayActions?: PersistedActionLogEntry[];
  metricsSeed?: SessionMetricsSeed;
}

function normalizeSessionState(state: string): GameState {
  const normalizedState = state.trim().toUpperCase();
  if (GAME_STATES.includes(normalizedState as GameState)) {
    return normalizedState as GameState;
  }

  return "NOT_FINISHED";
}

export function isWinStateValue(state: GameState): boolean {
  return state === "WIN";
}

export function isFailureStateValue(state: GameState): boolean {
  return state === "GAME_OVER";
}

function hasGameplayActions(actions: readonly ActionName[]): boolean {
  return actions.some((action) => action !== "HELP" && action !== "RESET");
}

export function isPostGameSession(session: RuntimeSession | null): boolean {
  if (!session) {
    return false;
  }

  const requiredWins = Math.max(1, session.winLevels);

  if (isWinStateValue(session.state) || isFailureStateValue(session.state)) {
    return true;
  }

  if (session.levelsCompleted >= requiredWins) {
    return true;
  }

  return !hasGameplayActions(session.availableActions);
}

export function preferSessionGameId(
  currentGameId: string,
  nextGameId: string,
): string {
  if (nextGameId && nextGameId.includes("-")) {
    return nextGameId;
  }

  return currentGameId;
}

export function toActionLogEntry(
  action: BackendActionName,
  extraData: Record<string, unknown>,
): PersistedActionLogEntry {
  const entry: PersistedActionLogEntry = { action };
  if (action === "ACTION6") {
    if (typeof extraData.x === "number" && Number.isFinite(extraData.x)) {
      entry.x = Math.max(0, Math.trunc(extraData.x));
    }
    if (typeof extraData.y === "number" && Number.isFinite(extraData.y)) {
      entry.y = Math.max(0, Math.trunc(extraData.y));
    }
  }

  return entry;
}

export function toPersistedRunSessionState(
  session: RuntimeSession,
): PersistedRunSessionState {
  const levelsCompleted = Math.max(0, session.levelsCompleted);

  return {
    gameId: session.gameId,
    state: session.state,
    availableActions: session.availableActions,
    grid: session.grid,
    countedActions: Math.max(1, session.countedActions),
    levelsCompleted,
    winLevels: Math.max(1, session.winLevels),
    levelActionCounts: session.levelActionCounts
      .map((value) => Math.max(0, Math.trunc(value)))
      .slice(0, levelsCompleted),
    currentLevelStartActionCount: Math.max(
      1,
      Math.min(session.countedActions, session.currentLevelStartActionCount),
    ),
    actionLog: session.actionLog,
  };
}

export function toRuntimeSessionFromPersisted(
  persistedSession: PersistedRunSessionState,
): RuntimeSession {
  return {
    gameId: persistedSession.gameId,
    state: normalizeSessionState(persistedSession.state),
    frames: [],
    grid: persistedSession.grid,
    availableActions: persistedSession.availableActions,
    countedActions: Math.max(1, persistedSession.countedActions),
    levelsCompleted: Math.max(0, persistedSession.levelsCompleted),
    winLevels: Math.max(1, persistedSession.winLevels),
    levelActionCounts: persistedSession.levelActionCounts
      .map((value) => Math.max(0, Math.trunc(value)))
      .slice(0, Math.max(0, persistedSession.levelsCompleted)),
    currentLevelStartActionCount: Math.max(
      1,
      Math.min(
        Math.max(1, persistedSession.countedActions),
        persistedSession.currentLevelStartActionCount,
      ),
    ),
    actionLog: persistedSession.actionLog,
  };
}

export function buildRuntimeSessionFromBootstrap(
  bootstrapped: BootstrappedSession,
  actionLog: PersistedActionLogEntry[],
  metricsSeed: SessionMetricsSeed = null,
): RuntimeSession {
  const countedActions = Math.max(1, actionLog.length + 1);
  const canReuseMetrics =
    metricsSeed !== undefined &&
    metricsSeed !== null &&
    Math.max(1, metricsSeed.countedActions) === countedActions;
  const currentLevelStartActionCount = canReuseMetrics
    ? Math.max(
        1,
        Math.min(countedActions, metricsSeed.currentLevelStartActionCount),
      )
    : countedActions;

  return {
    gameId: preferSessionGameId(
      bootstrapped.daily.resolvedGameId,
      bootstrapped.frame.gameId,
    ),
    state: bootstrapped.frame.state,
    frames: bootstrapped.frame.frame,
    grid: bootstrapped.frame.grid,
    availableActions: bootstrapped.frame.availableActions,
    countedActions,
    levelsCompleted: bootstrapped.frame.levelsCompleted,
    winLevels: bootstrapped.frame.winLevels,
    levelActionCounts: canReuseMetrics
      ? metricsSeed.levelActionCounts
          .map((value) => Math.max(0, Math.trunc(value)))
          .slice(0, Math.max(0, bootstrapped.frame.levelsCompleted))
      : [],
    currentLevelStartActionCount,
    actionLog: actionLog.slice(),
  };
}

export function deriveLevelActionCounts(
  previousSession: RuntimeSession,
  nextCountedActions: number,
  nextLevelsCompleted: number,
): {
  levelActionCounts: number[];
  currentLevelStartActionCount: number;
} {
  if (
    nextLevelsCompleted < previousSession.levelsCompleted ||
    nextCountedActions < previousSession.countedActions
  ) {
    return {
      levelActionCounts: [],
      currentLevelStartActionCount: nextCountedActions,
    };
  }

  const nextLevelActionCounts = previousSession.levelActionCounts.slice();
  let nextCurrentLevelStartActionCount =
    previousSession.currentLevelStartActionCount;

  if (nextLevelsCompleted > previousSession.levelsCompleted) {
    const completedDelta =
      nextLevelsCompleted - previousSession.levelsCompleted;
    const completedLevelActions = Math.max(
      0,
      nextCountedActions - previousSession.currentLevelStartActionCount,
    );

    nextLevelActionCounts.push(completedLevelActions);
    for (let index = 1; index < completedDelta; index += 1) {
      nextLevelActionCounts.push(0);
    }

    nextCurrentLevelStartActionCount = nextCountedActions;
  }

  if (nextLevelActionCounts.length > nextLevelsCompleted) {
    nextLevelActionCounts.length = nextLevelsCompleted;
  }

  return {
    levelActionCounts: nextLevelActionCounts,
    currentLevelStartActionCount: nextCurrentLevelStartActionCount,
  };
}

export class GameEnvironment {
  private _daily: DailyPuzzle | null = null;
  private _lockedDailyDate: string | null = null;
  private _session: RuntimeSession | null = null;

  constructor(private readonly api: GameEnvironmentApi) {}

  get daily(): DailyPuzzle | null {
    return this._daily;
  }

  get lockedDailyDate(): string | null {
    return this._lockedDailyDate;
  }

  get session(): RuntimeSession | null {
    return this._session;
  }

  isDailyLockedOut(): boolean {
    const dailyDate = this._daily?.date;
    return Boolean(dailyDate && this._lockedDailyDate === dailyDate);
  }

  resetForEditionDate(targetEditionDate: string): SessionChange & {
    previousEditionDate: string | null;
  } {
    const currentEditionDate = this._daily?.date ?? null;
    if (!currentEditionDate || currentEditionDate === targetEditionDate) {
      return {
        previousEditionDate: null,
        previousSession: this._session,
        session: this._session,
      };
    }

    const previousSession = this._session;
    this._session = null;
    this._daily = null;
    this._lockedDailyDate = null;
    clearPersistedRunState();

    return {
      previousEditionDate: currentEditionDate,
      previousSession,
      session: this._session,
    };
  }

  async initializeFromBoot(editionDate: string): Promise<ActiveSessionChange> {
    const persisted = readPersistedRunState();
    const isSameDayPersisted = Boolean(
      persisted && persisted.dailyDate === editionDate,
    );

    if (persisted && isSameDayPersisted && persisted.status === "completed") {
      const previousSession = this._session;
      this._daily = {
        date: persisted.dailyDate,
        gameId: persisted.dailyGameId,
        resolvedGameId: persisted.resolvedGameId,
        baselineActions: persisted.baselineActions,
      };
      const restoredSession = toRuntimeSessionFromPersisted(persisted.session);
      this._session = restoredSession;
      this.persistRunState();

      return {
        previousSession,
        session: restoredSession,
      };
    }

    const replayActions =
      persisted?.status === "in_progress" && isSameDayPersisted
        ? persisted.session.actionLog
        : [];

    const bootstrapped = await this.api.bootstrapDailySession({
      editionDate,
      replayActions,
    });

    const previousSession = this._session;
    this._daily = bootstrapped.daily;

    if (persisted && !isSameDayPersisted) {
      clearPersistedRunState();
      this._lockedDailyDate = null;
    }

    const restoredSession = buildRuntimeSessionFromBootstrap(
      bootstrapped,
      isSameDayPersisted && persisted?.status === "in_progress"
        ? persisted.session.actionLog
        : [],
      isSameDayPersisted && persisted?.status === "in_progress"
        ? persisted.session
        : null,
    );
    this._session = restoredSession;
    this.persistRunState();

    return {
      previousSession,
      session: restoredSession,
    };
  }

  async startSession(
    options: StartSessionOptions = {},
  ): Promise<ActiveSessionChange> {
    const editionDate = options.editionDate ?? getSelectedEditionDate();
    const replayActions = options.replayActions ?? [];

    const bootstrapped = await this.api.bootstrapDailySession({
      editionDate,
      replayActions,
    });

    const previousSession = this._session;
    this._daily = bootstrapped.daily;
    const openedSession = buildRuntimeSessionFromBootstrap(
      bootstrapped,
      replayActions,
      options.metricsSeed ?? null,
    );
    this._session = openedSession;
    this.persistRunState();

    return {
      previousSession,
      session: openedSession,
    };
  }

  async act(
    action: BackendActionName,
    extraData: Record<string, unknown> = {},
    options?: { editionDate?: string | null },
  ): Promise<ActiveSessionChange> {
    const activeSession = this._session;
    if (!activeSession) {
      throw new Error("No active session");
    }

    const nextFrame = await this.api.sendAction(action, extraData, {
      editionDate:
        options?.editionDate ?? this._daily?.date ?? getSelectedEditionDate(),
    });

    const nextCountedActions = activeSession.countedActions + 1;
    const nextActionLog = [
      ...activeSession.actionLog,
      toActionLogEntry(action, extraData),
    ];

    const nextSession: RuntimeSession = {
      ...activeSession,
      gameId: preferSessionGameId(activeSession.gameId, nextFrame.gameId),
      state: nextFrame.state,
      frames: nextFrame.frame,
      grid: nextFrame.grid,
      availableActions: nextFrame.availableActions,
      countedActions: nextCountedActions,
      levelsCompleted: nextFrame.levelsCompleted,
      winLevels: nextFrame.winLevels,
      actionLog: nextActionLog,
      ...deriveLevelActionCounts(
        activeSession,
        nextCountedActions,
        nextFrame.levelsCompleted,
      ),
    };

    this._session = nextSession;
    this.persistRunState();

    return {
      previousSession: activeSession,
      session: nextSession,
    };
  }

  async unloadDailySession(editionDate?: string | null): Promise<void> {
    await this.api.unloadDailySession(editionDate);
  }

  private persistRunState(): void {
    const dailyDate = this._daily?.date;
    if (!dailyDate) {
      return;
    }

    const existing = readPersistedRunState();
    if (!this._session) {
      if (
        existing &&
        existing.dailyDate === dailyDate &&
        existing.status === "in_progress"
      ) {
        clearPersistedRunState();
      }
      return;
    }

    const sessionState = toPersistedRunSessionState(this._session);
    if (isPostGameSession(this._session)) {
      writePersistedRunState({
        version: 2,
        dailyDate,
        dailyGameId: this._daily?.gameId ?? this._session.gameId,
        resolvedGameId: this._daily?.resolvedGameId ?? this._session.gameId,
        baselineActions: this._daily?.baselineActions ?? null,
        status: "completed",
        session: sessionState,
        completedAt: new Date().toISOString(),
      });
      this._lockedDailyDate = dailyDate;
      return;
    }

    writePersistedRunState({
      version: 2,
      dailyDate,
      dailyGameId: this._daily?.gameId ?? this._session.gameId,
      resolvedGameId: this._daily?.resolvedGameId ?? this._session.gameId,
      baselineActions: this._daily?.baselineActions ?? null,
      status: "in_progress",
      session: sessionState,
    });
  }
}
