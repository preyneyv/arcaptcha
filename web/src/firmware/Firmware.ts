import copy from "copy-to-clipboard";
import {
  getSelectedEditionDate,
  isSessionMissingError,
  type ActionName,
  type BootstrappedSession,
  type CommandFrame,
  type DailyPuzzle,
  type GameplayActionName,
} from "../lib/api";
import {
  clearPersistedRunState,
  readPersistedRunState,
  writePersistedRunState,
  type PersistedActionLogEntry,
  type PersistedRunSessionState,
} from "../lib/storage";
import {
  GAMEPLAY_HEIGHT,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  type Framebuffer,
} from "./framebuffer";
import {
  findHotspot,
  getLevelScorePercent,
  getPerformanceBand,
  type ControlState,
  type FirmwareFrame,
  type FirmwareModel,
  type HoverPoint,
  type MenuActionId,
  type PostGameBand,
  type PostGameLevelMetric,
  type PostGameOutcome,
  type PostGameStats,
  type SceneKind,
  type SessionSnapshot,
} from "./os";
import {
  AboutSceneModule,
  ErrorSceneModule,
  HelpSceneModule,
  PlaySceneModule,
  WinSceneModule,
  type SceneContext,
  type SceneModule,
} from "./scenes";

type BackendActionName = GameplayActionName;

interface RuntimeSession {
  gameId: string;
  state: string;
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

interface FirmwareState {
  daily: DailyPuzzle | null;
  lockedDailyDate: string | null;
  session: RuntimeSession | null;
  scene: SceneKind;
  booting: boolean;
  requestBusy: boolean;
  playbackBusy: boolean;
  error: string | null;
  hoverPoint: HoverPoint | null;
  clickPoint: HoverPoint | null;
  displayGrid: number[][] | null;
}

export interface FirmwareBusyState {
  booting: boolean;
  request: boolean;
  playback: boolean;
  inputLocked: boolean;
}

export interface FirmwareSnapshot {
  framebuffer: Framebuffer;
  controls: ControlState;
  screenInteractive: boolean;
  scene: SceneKind;
  busy: FirmwareBusyState;
  error: string | null;
}

export interface FirmwareEventMap {
  snapshot: FirmwareSnapshot;
}

export interface FirmwareApi {
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

export interface FirmwareScheduler {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | null): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number | null): void;
}

export interface FirmwareTimings {
  framePlaybackMs: number;
  clickPulseMs: number;
  sceneTransitionMs: number;
  interLevelTransitionMs: number;
}

export interface FirmwareDeps {
  api: FirmwareApi;
  ensurePlayerId?: () => string;
  scheduler?: FirmwareScheduler;
  timings?: Partial<FirmwareTimings>;
}

type FirmwareListeners = {
  [K in keyof FirmwareEventMap]: Set<(payload: FirmwareEventMap[K]) => void>;
};

const DEFAULT_TIMINGS: FirmwareTimings = {
  framePlaybackMs: 1000 / 24,
  clickPulseMs: 140,
  sceneTransitionMs: 220,
  interLevelTransitionMs: 280,
};

const SHARE_COPY_THROTTLE_MS = 300;

export type ShareTransferMode = "none" | "clipboard" | "share-sheet";

const FAILURE_STATES = new Set([
  "FAIL",
  "FAILED",
  "LOSS",
  "LOSE",
  "LOST",
  "GAME_OVER",
  "GAMEOVER",
]);

const DEFAULT_SCHEDULER: FirmwareScheduler = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => {
    if (id !== null) {
      window.clearTimeout(id);
    }
  },
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => {
    if (id !== null) {
      window.clearInterval(id);
    }
  },
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isIosOrAndroidPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = (navigator.userAgent || navigator.vendor || "").toLowerCase();
  const isAndroid = ua.includes("android");
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isIPadOS = ua.includes("macintosh") && navigator.maxTouchPoints > 1;

  return isAndroid || isIOS || isIPadOS;
}

function preferSessionGameId(
  currentGameId: string,
  nextGameId: string,
): string {
  if (nextGameId && nextGameId.includes("-")) {
    return nextGameId;
  }

  return currentGameId;
}

function toActionLogEntry(
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

function toSessionSnapshot(
  session: RuntimeSession | null,
  displayGrid: number[][] | null,
): SessionSnapshot | null {
  if (!session) {
    return null;
  }

  return {
    state: session.state,
    grid: displayGrid ?? session.grid,
    availableActions: session.availableActions,
    countedActions: session.countedActions,
    levelsCompleted: session.levelsCompleted,
    winLevels: session.winLevels,
    levelActionCounts: session.levelActionCounts,
  };
}

function toPersistedRunSessionState(
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

function toRuntimeSessionFromPersisted(
  persistedSession: PersistedRunSessionState,
): RuntimeSession {
  return {
    gameId: persistedSession.gameId,
    state: persistedSession.state,
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

function buildRuntimeSessionFromBootstrap(
  bootstrapped: BootstrappedSession,
  actionLog: PersistedActionLogEntry[],
  metricsSeed?:
    | Pick<
        RuntimeSession,
        "countedActions" | "levelActionCounts" | "currentLevelStartActionCount"
      >
    | Pick<
        PersistedRunSessionState,
        "countedActions" | "levelActionCounts" | "currentLevelStartActionCount"
      >
    | null,
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

function deriveLevelActionCounts(
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

function normalizeSessionState(state: string): string {
  return state.trim().toUpperCase();
}

function isWinStateValue(state: string): boolean {
  return normalizeSessionState(state) === "WIN";
}

function isFailureStateValue(state: string): boolean {
  const normalizedState = normalizeSessionState(state);
  return (
    FAILURE_STATES.has(normalizedState) || normalizedState.startsWith("FAIL")
  );
}

function hasGameplayActions(actions: readonly ActionName[]): boolean {
  return actions.some((action) => action !== "HELP" && action !== "RESET");
}

function isPostGameSession(session: RuntimeSession | null): boolean {
  if (!session) {
    return false;
  }

  if (isWinStateValue(session.state) || isFailureStateValue(session.state)) {
    return true;
  }

  // Fallback: a locked-out session that has no gameplay actions before full completion
  // is treated as a failed run so we can show post-game diagnostics.
  return (
    !hasGameplayActions(session.availableActions) &&
    session.levelsCompleted < Math.max(1, session.winLevels)
  );
}

function getSceneForSession(session: RuntimeSession | null): SceneKind {
  if (isPostGameSession(session)) {
    return "win";
  }

  return "play";
}

function buildPostGameLevelMetrics(
  levelsCompleted: number,
  winLevels: number,
  outcome: PostGameOutcome,
  levelActionCounts: readonly number[],
  baselineActionsByLevel: readonly number[] | null | undefined,
): PostGameLevelMetric[] {
  const levelMetrics: PostGameLevelMetric[] = [];

  for (let level = 1; level <= winLevels; level += 1) {
    if (level <= levelsCompleted) {
      const levelIndex = level - 1;
      const scorePercent = getLevelScorePercent(
        levelActionCounts[levelIndex],
        baselineActionsByLevel?.[levelIndex],
      );

      levelMetrics.push({
        level,
        band: getPerformanceBand(scorePercent),
      });
      continue;
    }

    if (outcome === "fail" && level === levelsCompleted + 1) {
      levelMetrics.push({
        level,
        band: "red",
      });
      continue;
    }

    levelMetrics.push({
      level,
      band: "neutral",
    });
  }

  return levelMetrics;
}

function buildPostGameShareText(
  daily: DailyPuzzle | null,
  stats: {
    outcome: PostGameOutcome;
    levelsCompleted: number;
    winLevels: number;
    countedActions: number;
    baselineActions: number | null;
    scorePercent: number | null;
    levelMetrics: PostGameLevelMetric[];
  },
): string {
  const glyphByBand: Record<PostGameBand, string> = {
    red: "🟥",
    yellow: "🟨",
    green: "🟩",
    blue: "🟦",
    neutral: "⬛",
  };

  const dayLabel = daily?.gameId || "Unknown";
  const levels =
    stats.levelMetrics.length > 0
      ? stats.levelMetrics.map((entry) => glyphByBand[entry.band]).join("")
      : glyphByBand.neutral;

  return [
    `ARCaptcha #${dayLabel} ⚡ ${stats.countedActions} moves`,
    levels,
    "https://arcaptcha.io",
  ].join("\n");
}

function toPostGameStats(
  session: RuntimeSession | null,
  daily: DailyPuzzle | null,
): PostGameStats | null {
  if (!isPostGameSession(session) || !session) {
    return null;
  }

  const outcome: PostGameOutcome = isWinStateValue(session.state)
    ? "win"
    : "fail";
  const winLevels = Math.max(1, session.winLevels);
  const levelsCompleted = Math.max(
    0,
    Math.min(session.levelsCompleted, winLevels),
  );
  const countedActions = Math.max(0, session.countedActions);
  const baselineActions = sumBaselineActions(daily?.baselineActions);
  const deltaActions =
    baselineActions === null ? null : countedActions - baselineActions;
  const scorePercent =
    baselineActions !== null && countedActions > 0
      ? Math.round((baselineActions / countedActions) * 100)
      : null;
  const levelMetrics = buildPostGameLevelMetrics(
    levelsCompleted,
    winLevels,
    outcome,
    session.levelActionCounts,
    daily?.baselineActions,
  );

  return {
    outcome,
    headline: outcome === "win" ? "ENVIRONMENT CLEARED" : "ENVIRONMENT FAILED",
    detail:
      outcome === "win"
        ? "Post-game stats are ready."
        : "Run ended before completion.",
    countedActions,
    baselineActions,
    deltaActions,
    scorePercent,
    levelsCompleted,
    winLevels,
    levelMetrics,
    shareText: buildPostGameShareText(daily, {
      outcome,
      levelsCompleted,
      winLevels,
      countedActions,
      baselineActions,
      scorePercent,
      levelMetrics,
    }),
  };
}

function sumBaselineActions(
  baselineActionsByLevel: readonly number[] | null | undefined,
): number | null {
  if (!baselineActionsByLevel || baselineActionsByLevel.length === 0) {
    return null;
  }

  let total = 0;
  let hasValue = false;

  for (const value of baselineActionsByLevel) {
    if (!Number.isFinite(value)) {
      continue;
    }

    total += Math.max(0, Math.trunc(value));
    hasValue = true;
  }

  if (!hasValue) {
    return null;
  }

  return total;
}

function getFrameSequence(session: RuntimeSession | null): number[][][] {
  if (!session) {
    return [];
  }

  if (session.frames.length > 0) {
    return session.frames;
  }

  return session.grid.length > 0 ? [session.grid] : [];
}

export class Firmware {
  private readonly api: FirmwareApi;
  private readonly scheduler: FirmwareScheduler;
  private readonly timings: FirmwareTimings;
  private readonly ensurePlayerId?: () => string;
  private readonly listeners: FirmwareListeners = {
    snapshot: new Set(),
  };
  private readonly helpScene = new HelpSceneModule();
  private readonly aboutScene = new AboutSceneModule();
  private readonly playScene: PlaySceneModule;
  private readonly winScene = new WinSceneModule();
  private readonly errorScene = new ErrorSceneModule();

  private state: FirmwareState = {
    daily: null,
    lockedDailyDate: null,
    session: null,
    scene: "help",
    booting: true,
    requestBusy: false,
    playbackBusy: false,
    error: null,
    hoverPoint: null,
    clickPoint: null,
    displayGrid: null,
  };

  private snapshot: FirmwareSnapshot;
  private latestFrame: FirmwareFrame;
  private bootPromise: Promise<void> | null = null;
  private startSessionPromise: Promise<RuntimeSession | null> | null = null;
  private pendingSessionReveal = false;
  private playbackTimerId: number | null = null;
  private clickPulseTimerId: number | null = null;
  private postRenderSceneTimerId: number | null = null;
  private localAnimationTimerId: number | null = null;
  private sceneTransitionTimerId: number | null = null;
  private sceneTransitionFrom: Framebuffer | null = null;
  private sceneTransitionTarget: SceneKind | null = null;
  private sceneTransitionStartMs = 0;
  private winCountdownTimerId: number | null = null;
  private pendingSceneAfterPlayback: SceneKind | null = null;
  private pendingSceneAfterRender: SceneKind | null = null;
  private pendingPlaySceneAnimationAfterPlayback = false;
  private pendingPlaySceneAnimationAfterRender = false;
  private lastShareCopyAtMs = 0;
  private disposed = false;
  private lifecycleId = 0;

  constructor(deps: FirmwareDeps) {
    this.api = deps.api;
    this.ensurePlayerId = deps.ensurePlayerId;
    this.scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
    this.timings = {
      ...DEFAULT_TIMINGS,
      ...deps.timings,
    };
    this.playScene = new PlaySceneModule(this.timings.interLevelTransitionMs);

    this.helpScene.onEnter();
    this.aboutScene.onEnter();
    this.playScene.onEnter();
    this.winScene.onEnter();
    this.errorScene.onEnter();

    this.latestFrame = this.renderCurrentScene(this.buildModel());
    this.snapshot = this.buildSnapshot(this.latestFrame);
  }

  boot(): Promise<void> {
    if (this.disposed) {
      this.disposed = false;
    }

    if (this.bootPromise) {
      return this.bootPromise;
    }

    this.renderAndEmit();

    const lifecycle = this.lifecycleId;
    this.bootPromise = (async () => {
      this.ensurePlayerId?.();
      this.state.booting = true;
      this.renderAndEmit();

      try {
        await this.restorePersistedRun(lifecycle);
      } catch (loadError) {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.state.error = getErrorMessage(loadError);
        this.renderAndEmit();
      } finally {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.state.booting = false;
        this.renderAndEmit();
      }
    })();

    return this.bootPromise;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.lifecycleId += 1;
    this.bootPromise = null;
    this.startSessionPromise = null;
    this.pendingSessionReveal = false;
    this.stopPlayback();
    this.stopClickPulse();
    this.clearQueuedSceneAfterRender();
    this.stopLocalAnimationLoop();
    this.stopSceneTransition();
    this.stopWinCountdown();
    this.pendingSceneAfterPlayback = null;
    this.clearQueuedPlaySceneAnimation();
    this.playScene.clearLocalAnimation();
    this.state.requestBusy = false;

    for (const eventName of Object.keys(this.listeners) as Array<
      keyof FirmwareEventMap
    >) {
      this.listeners[eventName].clear();
    }
  }

  getSnapshot(): FirmwareSnapshot {
    return this.snapshot;
  }

  getActiveEditionDate(): string | null {
    return this.state.daily?.date ?? null;
  }

  on<E extends keyof FirmwareEventMap>(
    event: E,
    listener: (payload: FirmwareEventMap[E]) => void,
  ): () => void {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  private getShareTextForCurrentScene(): string | null {
    if (this.state.scene !== "win") {
      return null;
    }

    return (
      toPostGameStats(this.state.session, this.state.daily)?.shareText ?? null
    );
  }

  private copyShareTextNow(shareText: string): ShareTransferMode {
    const now = Date.now();
    if (now - this.lastShareCopyAtMs < SHARE_COPY_THROTTLE_MS) {
      return "none";
    }

    if (
      isIosOrAndroidPlatform() &&
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      this.lastShareCopyAtMs = now;
      void navigator.share({ text: shareText }).catch(() => {
        // Ignore cancellation/failures; share UI can be dismissed by the user.
      });
      return "share-sheet";
    }

    const copied = copy(shareText, { format: "text/plain" });
    if (copied) {
      this.lastShareCopyAtMs = now;
      return "clipboard";
    }

    return "none";
  }

  tryCopyShareForAction(action: ActionName): ShareTransferMode {
    if (this.disposed || action !== "ACTION5" || this.isInputLocked()) {
      return "none";
    }

    const shareText = this.getShareTextForCurrentScene();
    if (!shareText) {
      return "none";
    }

    return this.copyShareTextNow(shareText);
  }

  tryCopyShareForPoint(point: HoverPoint): ShareTransferMode {
    if (this.disposed || this.isInputLocked() || this.state.scene !== "win") {
      return "none";
    }

    const bounds = WinSceneModule.SHARE_HOTSPOT_BOUNDS;
    const isInShareHotspot =
      point.x >= bounds.x &&
      point.x < bounds.x + bounds.width &&
      point.y >= bounds.y &&
      point.y < bounds.y + bounds.height;

    if (!isInShareHotspot) {
      return "none";
    }

    const shareText = this.getShareTextForCurrentScene();
    if (!shareText) {
      return "none";
    }

    return this.copyShareTextNow(shareText);
  }

  async dispatchAction(action: ActionName): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (action === "HELP") {
      this.enterHelpMenu(true);
      return;
    }

    await this.getActiveScene().dispatchAction(
      action,
      this.createSceneContext(),
    );
  }

  async pressScreen(point: HoverPoint): Promise<void> {
    if (this.disposed) {
      return;
    }

    await this.getActiveScene().pressScreen(
      point,
      this.latestFrame,
      this.createSceneContext(),
    );
  }

  setHoverPoint(point: HoverPoint | null): boolean {
    if (this.disposed) {
      return false;
    }

    if (!this.canTrackHover()) {
      if (this.state.hoverPoint === null) {
        return false;
      }

      this.state.hoverPoint = null;
      this.renderAndEmit();
      return false;
    }

    if (point === null) {
      if (this.state.hoverPoint === null) {
        return false;
      }

      this.state.hoverPoint = null;
      this.renderAndEmit();
      return false;
    }

    if (
      this.state.hoverPoint?.x === point.x &&
      this.state.hoverPoint.y === point.y
    ) {
      return this.getPointInteractivity(point, this.latestFrame);
    }

    this.state.hoverPoint = point;
    this.renderAndEmit();
    return this.snapshot.screenInteractive;
  }

  private emit<E extends keyof FirmwareEventMap>(
    event: E,
    payload: FirmwareEventMap[E],
  ): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }

  private isInputLocked(): boolean {
    return (
      this.state.requestBusy ||
      this.state.playbackBusy ||
      this.pendingSceneAfterRender !== null ||
      this.hasActiveSceneLocalAnimation()
    );
  }

  private isLifecycleCurrent(lifecycle: number): boolean {
    return !this.disposed && this.lifecycleId === lifecycle;
  }

  private isDailyLockedOut(): boolean {
    const dailyDate = this.state.daily?.date;
    return Boolean(dailyDate && this.state.lockedDailyDate === dailyDate);
  }

  private resetForEditionDate(targetEditionDate: string): string | null {
    const currentEditionDate = this.state.daily?.date ?? null;
    if (!currentEditionDate || currentEditionDate === targetEditionDate) {
      return null;
    }

    this.syncSession(null);
    clearPersistedRunState();
    this.state.daily = null;
    this.state.lockedDailyDate = null;
    this.state.error = null;
    this.state.hoverPoint = null;
    this.state.clickPoint = null;
    this.state.scene = "help";
    this.helpScene.onEnter();
    return currentEditionDate;
  }

  private persistRunState(session: RuntimeSession | null): void {
    const dailyDate = this.state.daily?.date;
    if (!dailyDate) {
      return;
    }

    const existing = readPersistedRunState();
    if (!session) {
      if (
        existing &&
        existing.dailyDate === dailyDate &&
        existing.status === "in_progress"
      ) {
        clearPersistedRunState();
      }
      return;
    }

    const sessionState = toPersistedRunSessionState(session);
    if (isPostGameSession(session)) {
      writePersistedRunState({
        version: 2,
        dailyDate,
        dailyGameId: this.state.daily?.gameId ?? session.gameId,
        resolvedGameId: this.state.daily?.resolvedGameId ?? session.gameId,
        baselineActions: this.state.daily?.baselineActions ?? null,
        status: "completed",
        session: sessionState,
        completedAt: new Date().toISOString(),
      });
      this.state.lockedDailyDate = dailyDate;
      return;
    }

    writePersistedRunState({
      version: 2,
      dailyDate,
      dailyGameId: this.state.daily?.gameId ?? session.gameId,
      resolvedGameId: this.state.daily?.resolvedGameId ?? session.gameId,
      baselineActions: this.state.daily?.baselineActions ?? null,
      status: "in_progress",
      session: sessionState,
    });
  }

  private async restorePersistedRun(lifecycle: number): Promise<void> {
    const selectedEditionDate = getSelectedEditionDate();
    const persisted = readPersistedRunState();
    const replayActions =
      persisted?.status === "in_progress" &&
      persisted.dailyDate === selectedEditionDate
        ? persisted.session.actionLog
        : [];

    const bootstrapped = await this.api.bootstrapDailySession({
      editionDate: selectedEditionDate,
      replayActions,
    });
    if (!this.isLifecycleCurrent(lifecycle)) {
      return;
    }

    this.state.daily = bootstrapped.daily;
    this.state.error = null;

    const isSameDayPersisted = Boolean(
      persisted && persisted.dailyDate === selectedEditionDate,
    );
    if (persisted && !isSameDayPersisted) {
      clearPersistedRunState();
      this.state.lockedDailyDate = null;
    }

    if (persisted && isSameDayPersisted && persisted.status === "completed") {
      const restoredSession = toRuntimeSessionFromPersisted(persisted.session);
      this.syncSession(restoredSession);
      this.state.lockedDailyDate = bootstrapped.daily.date;
      this.state.scene = "help";
      this.helpScene.onEnter();
      this.renderAndEmit();
      void this.api.unloadDailySession(bootstrapped.daily.date).catch(() => {
        // Ignore best-effort unload failures after local completion.
      });
      return;
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
    this.syncSession(restoredSession);
    this.state.scene = "help";
    this.helpScene.onEnter();
    this.renderAndEmit();
  }

  private canTrackHover(frame: FirmwareFrame = this.latestFrame): boolean {
    if (this.isInputLocked()) {
      return false;
    }

    if (frame.scene === "play") {
      return frame.controls.ACTION6;
    }

    return frame.hotspots.length > 0;
  }

  private getPointInteractivity(
    point: HoverPoint | null,
    frame: FirmwareFrame = this.latestFrame,
  ): boolean {
    if (!point || this.isInputLocked()) {
      return false;
    }

    if (frame.scene === "play" && frame.controls.ACTION6) {
      return point.y < GAMEPLAY_HEIGHT;
    }

    return findHotspot(frame.hotspots, point.x, point.y) !== null;
  }

  private buildBusyState(): FirmwareBusyState {
    return {
      booting: this.state.booting,
      request: this.state.requestBusy,
      playback: this.state.playbackBusy,
      inputLocked: this.isInputLocked(),
    };
  }

  private buildModel(): FirmwareModel {
    return {
      scene: this.state.scene,
      daily: this.state.daily,
      dailyLocked: this.isDailyLockedOut(),
      session: toSessionSnapshot(this.state.session, this.state.displayGrid),
      postGame: toPostGameStats(this.state.session, this.state.daily),
      hoverPoint: this.getPointInteractivity(this.state.hoverPoint)
        ? this.state.hoverPoint
        : null,
      clickPoint: this.state.clickPoint,
      busy: this.isInputLocked(),
      error: this.state.error,
    };
  }

  private buildSnapshot(frame: FirmwareFrame): FirmwareSnapshot {
    return {
      framebuffer: frame.framebuffer,
      controls: frame.controls,
      screenInteractive: this.getPointInteractivity(
        this.state.hoverPoint,
        frame,
      ),
      scene: frame.scene,
      busy: this.buildBusyState(),
      error: this.state.error,
    };
  }

  private getActiveScene(): SceneModule {
    if (this.state.error) {
      return this.errorScene;
    }

    if (this.state.scene === "help") {
      return this.helpScene;
    }

    if (this.state.scene === "about") {
      return this.aboutScene;
    }

    if (this.state.scene === "win") {
      return this.winScene;
    }

    return this.playScene;
  }

  private createSceneContext(): SceneContext {
    return {
      isInputLocked: () => this.isInputLocked(),
      hasPendingSessionStart: () => this.startSessionPromise !== null,
      hasSession: () => this.state.session !== null,
      canDispatchGameplayAction: (action: ActionName) =>
        Boolean(this.latestFrame.controls[action]),
      resetSession: (options?: { revealScene?: boolean }) =>
        this.resetSession(options),
      activateMenuAction: (action: MenuActionId) =>
        this.activateMenuAction(action),
      runGameplayAction: (
        action: Exclude<ActionName, "HELP">,
        extraData?: Record<string, unknown>,
      ) => this.runGameAction(action, extraData),
      pulseClickCursor: (point: HoverPoint) => {
        this.pulseClickCursor(point);
      },
      enterHelpMenu: (clearError: boolean = false) => {
        this.enterHelpMenu(clearError);
      },
      requestRender: () => {
        this.renderAndEmit();
      },
    };
  }

  private renderCurrentScene(model: FirmwareModel): FirmwareFrame {
    return this.getActiveScene().render(model);
  }

  private hasActiveSceneLocalAnimation(): boolean {
    return this.getActiveScene().hasActiveLocalAnimation?.() ?? false;
  }

  private startLocalAnimationLoop(): void {
    if (this.localAnimationTimerId !== null) {
      return;
    }

    this.localAnimationTimerId = this.scheduler.setInterval(() => {
      if (this.disposed) {
        return;
      }

      this.renderAndEmit();
    }, 1000 / 60);
  }

  private stopLocalAnimationLoop(): void {
    this.scheduler.clearInterval(this.localAnimationTimerId);
    this.localAnimationTimerId = null;
  }

  private syncLocalAnimationLoop(): void {
    if (this.hasActiveSceneLocalAnimation()) {
      this.startLocalAnimationLoop();
      return;
    }

    this.stopLocalAnimationLoop();
  }

  private clearQueuedPlaySceneAnimation(): void {
    this.pendingPlaySceneAnimationAfterPlayback = false;
    this.pendingPlaySceneAnimationAfterRender = false;
  }

  private queueSceneAfterRender(scene: SceneKind): void {
    this.pendingSceneAfterRender = scene;
  }

  private clearQueuedSceneAfterRender(): void {
    this.pendingSceneAfterRender = null;
    this.scheduler.clearTimeout(this.postRenderSceneTimerId);
    this.postRenderSceneTimerId = null;
  }

  private startQueuedSceneAfterRenderIfReady(): void {
    if (
      this.pendingSceneAfterRender === null ||
      this.postRenderSceneTimerId !== null
    ) {
      return;
    }

    this.postRenderSceneTimerId = this.scheduler.setTimeout(() => {
      if (this.disposed) {
        return;
      }

      const targetScene = this.pendingSceneAfterRender;
      this.pendingSceneAfterRender = null;
      this.postRenderSceneTimerId = null;
      if (targetScene === null) {
        return;
      }

      this.state.scene = targetScene;
      this.renderAndEmit();
    }, this.timings.framePlaybackMs);
  }

  private queuePlaySceneAnimationAfterPlayback(): void {
    this.pendingPlaySceneAnimationAfterPlayback = true;
  }

  private queuePlaySceneAnimationAfterRender(): void {
    this.pendingPlaySceneAnimationAfterRender = true;
  }

  private startQueuedPlaySceneAnimationAfterPlaybackIfReady(): void {
    if (!this.pendingPlaySceneAnimationAfterPlayback) {
      return;
    }

    this.pendingPlaySceneAnimationAfterPlayback = false;
    this.queuePlaySceneAnimationAfterRender();
  }

  private startQueuedPlaySceneAnimationAfterRenderIfReady(): void {
    if (!this.pendingPlaySceneAnimationAfterRender) {
      return;
    }

    this.pendingPlaySceneAnimationAfterRender = false;
    if (this.state.scene !== "play" || this.state.error) {
      return;
    }

    this.playScene.beginLocalAnimation(this.latestFrame.framebuffer);
    this.state.displayGrid = null;
  }

  private startSceneTransition(
    from: Framebuffer,
    targetScene: SceneKind,
  ): void {
    if (this.timings.sceneTransitionMs <= 0) {
      return;
    }

    this.sceneTransitionFrom = new Uint8Array(from);
    this.sceneTransitionTarget = targetScene;
    this.sceneTransitionStartMs = Date.now();
    this.clearQueuedSceneAfterRender();
    this.clearQueuedPlaySceneAnimation();
    this.playScene.clearLocalAnimation();
    this.stopLocalAnimationLoop();

    if (this.sceneTransitionTimerId !== null) {
      return;
    }

    this.sceneTransitionTimerId = this.scheduler.setInterval(() => {
      if (this.disposed) {
        return;
      }

      this.renderAndEmit();
    }, 1000 / 60);
  }

  private stopSceneTransition(): void {
    this.scheduler.clearInterval(this.sceneTransitionTimerId);
    this.sceneTransitionTimerId = null;
    this.sceneTransitionFrom = null;
    this.sceneTransitionTarget = null;
    this.sceneTransitionStartMs = 0;
  }

  private queueSceneAfterPlayback(scene: SceneKind): void {
    this.pendingSceneAfterPlayback = scene;
  }

  private clearQueuedSceneAfterPlayback(): void {
    this.pendingSceneAfterPlayback = null;
  }

  private startQueuedSceneAfterPlaybackIfReady(): void {
    if (this.pendingSceneAfterPlayback === null) {
      return;
    }

    this.state.scene = this.pendingSceneAfterPlayback;
    this.clearQueuedSceneAfterPlayback();
  }

  private createSceneTransitionFrame(
    from: Framebuffer,
    to: FirmwareFrame,
    progress: number,
  ): FirmwareFrame {
    const composited = new Uint8Array(from);
    const revealWidth = Math.max(
      1,
      Math.min(SCREEN_WIDTH, Math.floor(SCREEN_WIDTH * progress)),
    );

    for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
      const rowOffset = y * SCREEN_WIDTH;
      for (let x = 0; x < revealWidth - 1; x += 1) {
        composited[rowOffset + x] = to.framebuffer[rowOffset + x] ?? 0;
      }
      composited[rowOffset + revealWidth - 1] = 3;
    }

    return {
      ...to,
      framebuffer: composited,
    };
  }

  private applySceneTransition(nextFrame: FirmwareFrame): FirmwareFrame {
    if (
      this.sceneTransitionFrom === null ||
      this.sceneTransitionTarget !== nextFrame.scene
    ) {
      return nextFrame;
    }

    const elapsedMs = Date.now() - this.sceneTransitionStartMs;
    const progress = Math.min(1, elapsedMs / this.timings.sceneTransitionMs);

    if (progress >= 1) {
      this.stopSceneTransition();
      return nextFrame;
    }

    return this.createSceneTransitionFrame(
      this.sceneTransitionFrom,
      nextFrame,
      progress,
    );
  }

  private renderAndEmit(): void {
    if (this.disposed) {
      return;
    }

    let nextFrame = this.renderCurrentScene(this.buildModel());
    if (this.state.hoverPoint && !this.canTrackHover(nextFrame)) {
      this.state.hoverPoint = null;
      nextFrame = this.renderCurrentScene(this.buildModel());
    }

    if (nextFrame.scene !== this.latestFrame.scene) {
      this.startSceneTransition(this.latestFrame.framebuffer, nextFrame.scene);
    }

    if (nextFrame.scene !== "play") {
      this.playScene.clearLocalAnimation();
    }

    nextFrame = this.applySceneTransition(nextFrame);

    this.latestFrame = nextFrame;
    this.syncWinCountdown(this.latestFrame.scene === "win");
    this.snapshot = this.buildSnapshot(this.latestFrame);
    this.emit("snapshot", this.snapshot);
    this.startQueuedSceneAfterRenderIfReady();
    this.startQueuedPlaySceneAnimationAfterRenderIfReady();
    this.syncLocalAnimationLoop();
  }

  private startWinCountdown(): void {
    if (this.winCountdownTimerId !== null) {
      return;
    }

    this.winCountdownTimerId = this.scheduler.setInterval(() => {
      if (this.disposed) {
        return;
      }

      if (this.latestFrame.scene !== "win") {
        this.stopWinCountdown();
        return;
      }

      this.renderAndEmit();
    }, 200);
  }

  private stopWinCountdown(): void {
    this.scheduler.clearInterval(this.winCountdownTimerId);
    this.winCountdownTimerId = null;
  }

  private syncWinCountdown(shouldRun: boolean): void {
    if (shouldRun) {
      this.startWinCountdown();
      return;
    }

    this.stopWinCountdown();
  }

  private stopPlayback(): void {
    this.scheduler.clearInterval(this.playbackTimerId);
    this.playbackTimerId = null;
    this.state.playbackBusy = false;
  }

  private stopClickPulse(): void {
    this.scheduler.clearTimeout(this.clickPulseTimerId);
    this.clickPulseTimerId = null;
  }

  private syncSession(nextSession: RuntimeSession | null): void {
    this.stopPlayback();
    this.clearQueuedSceneAfterRender();
    this.stopLocalAnimationLoop();
    this.clearQueuedSceneAfterPlayback();
    this.clearQueuedPlaySceneAnimation();
    this.playScene.clearLocalAnimation();
    const previousSession = this.state.session;
    this.state.session = nextSession;

    if (
      nextSession &&
      isPostGameSession(nextSession) &&
      this.state.daily?.date
    ) {
      this.state.lockedDailyDate = this.state.daily.date;
    }

    this.persistRunState(nextSession);

    const shouldStartInterLevelTransition =
      this.state.scene === "play" &&
      previousSession !== null &&
      nextSession !== null &&
      !isPostGameSession(nextSession) &&
      nextSession.levelsCompleted > previousSession.levelsCompleted;

    const frames = getFrameSequence(nextSession);
    if (frames.length === 0) {
      this.state.displayGrid = null;
      return;
    }

    this.state.displayGrid = frames[0] ?? null;
    if (shouldStartInterLevelTransition) {
      if (frames.length > 1) {
        this.queuePlaySceneAnimationAfterPlayback();
      } else {
        this.queuePlaySceneAnimationAfterRender();
      }
    }

    if (frames.length === 1) {
      return;
    }

    this.state.playbackBusy = true;
    let frameIndex = 0;
    let awaitingQueuedTransitionStart = false;
    this.playbackTimerId = this.scheduler.setInterval(() => {
      if (this.disposed) {
        return;
      }

      const lastFrameIndex = frames.length - 1;

      if (awaitingQueuedTransitionStart) {
        this.stopPlayback();
        if (this.pendingSceneAfterPlayback !== null) {
          this.startQueuedSceneAfterPlaybackIfReady();
        } else {
          this.startQueuedPlaySceneAnimationAfterPlaybackIfReady();
        }
        this.renderAndEmit();
        return;
      }

      frameIndex += 1;
      this.state.displayGrid = frames[frameIndex] ?? null;

      if (frameIndex >= lastFrameIndex) {
        const hasQueuedTransition =
          this.pendingSceneAfterPlayback !== null ||
          this.pendingPlaySceneAnimationAfterPlayback;

        if (hasQueuedTransition) {
          awaitingQueuedTransitionStart = true;
        } else {
          this.stopPlayback();
        }
      }

      this.renderAndEmit();
    }, this.timings.framePlaybackMs);
  }

  private async startSession(options?: {
    revealScene?: boolean;
    replayActions?: PersistedActionLogEntry[];
    metricsSeed?:
      | Pick<
          RuntimeSession,
          | "countedActions"
          | "levelActionCounts"
          | "currentLevelStartActionCount"
        >
      | Pick<
          PersistedRunSessionState,
          | "countedActions"
          | "levelActionCounts"
          | "currentLevelStartActionCount"
        >
      | null;
    editionDate?: string | null;
  }): Promise<RuntimeSession | null> {
    const targetEditionDate = options?.editionDate ?? getSelectedEditionDate();
    const previousEditionDate = this.resetForEditionDate(targetEditionDate);
    if (previousEditionDate) {
      void this.api.unloadDailySession(previousEditionDate).catch(() => {
        // Ignore best-effort unload failures during local edition rollover.
      });
    }

    if (this.isDailyLockedOut()) {
      this.state.scene = "win";
      this.state.error = null;
      this.renderAndEmit();
      return this.state.session;
    }

    const revealScene = options?.revealScene ?? true;
    if (revealScene) {
      this.pendingSessionReveal = true;
    }

    const replayActions = options?.replayActions ?? [];

    if (this.startSessionPromise) {
      await this.startSessionPromise;
      return this.state.session;
    }

    const lifecycle = this.lifecycleId;
    const startTask = (async (): Promise<RuntimeSession | null> => {
      this.state.requestBusy = true;
      this.renderAndEmit();

      try {
        const bootstrapped = await this.api.bootstrapDailySession({
          editionDate: targetEditionDate,
          replayActions,
        });
        if (!this.isLifecycleCurrent(lifecycle)) {
          return null;
        }

        const shouldReveal = this.pendingSessionReveal;
        this.state.daily = bootstrapped.daily;
        const openedSession = buildRuntimeSessionFromBootstrap(
          bootstrapped,
          replayActions,
          options?.metricsSeed ?? null,
        );
        this.syncSession(openedSession);
        if (shouldReveal) {
          this.state.scene = getSceneForSession(openedSession);
        }
        this.state.error = null;
        this.renderAndEmit();
        return openedSession;
      } catch (sessionError) {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return null;
        }

        if (!this.state.session) {
          this.state.scene = "help";
          this.helpScene.onEnter();
        }
        this.state.error = getErrorMessage(sessionError);
        this.renderAndEmit();
        return null;
      } finally {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return null;
        }

        this.pendingSessionReveal = false;
        this.state.requestBusy = false;
        this.renderAndEmit();
      }
    })();

    this.startSessionPromise = startTask;
    try {
      return await startTask;
    } finally {
      if (this.startSessionPromise === startTask) {
        this.startSessionPromise = null;
      }
    }
  }

  private async runGameAction(
    action: BackendActionName,
    extraData: Record<string, unknown> = {},
    options?: { revealScene?: boolean; allowRecover?: boolean },
  ): Promise<void> {
    const selectedEditionDate = getSelectedEditionDate();
    if (
      this.state.daily?.date &&
      this.state.daily.date !== selectedEditionDate
    ) {
      await this.startSession({
        revealScene: true,
        editionDate: selectedEditionDate,
      });
      return;
    }

    if (this.isDailyLockedOut()) {
      this.state.scene = "win";
      this.renderAndEmit();
      return;
    }

    const activeSession = this.state.session;
    if (!activeSession) {
      await this.startSession({
        revealScene: true,
        editionDate: selectedEditionDate,
      });
      return;
    }

    const lifecycle = this.lifecycleId;
    this.state.requestBusy = true;
    this.renderAndEmit();

    try {
      const nextFrame = await this.api.sendAction(action, extraData, {
        editionDate: this.state.daily?.date ?? selectedEditionDate,
      });
      if (!this.isLifecycleCurrent(lifecycle)) {
        return;
      }

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
      this.syncSession(nextSession);
      this.state.error = null;
      if (options?.revealScene ?? this.state.scene !== "help") {
        const nextScene = getSceneForSession(nextSession);
        const shouldDelaySceneChangeUntilPlaybackCompletes =
          this.state.scene === "play" &&
          nextScene !== "play" &&
          nextSession.frames.length > 1;

        const shouldDelaySceneChangeUntilAfterCurrentRender =
          this.state.scene === "play" &&
          nextScene !== "play" &&
          nextSession.frames.length === 1;

        if (shouldDelaySceneChangeUntilPlaybackCompletes) {
          this.queueSceneAfterPlayback(nextScene);
        } else if (shouldDelaySceneChangeUntilAfterCurrentRender) {
          this.queueSceneAfterRender(nextScene);
        } else {
          this.state.scene = nextScene;
        }
      }
      this.renderAndEmit();
    } catch (actionError) {
      if (!this.isLifecycleCurrent(lifecycle)) {
        return;
      }

      if (
        isSessionMissingError(actionError) &&
        (options?.allowRecover ?? true)
      ) {
        const recoveredSession = await this.startSession({
          revealScene: false,
          replayActions: activeSession.actionLog,
          metricsSeed: activeSession,
          editionDate: this.state.daily?.date ?? selectedEditionDate,
        });
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        if (recoveredSession) {
          await this.runGameAction(action, extraData, {
            revealScene: options?.revealScene,
            allowRecover: false,
          });
          return;
        }
      }
      this.state.error = getErrorMessage(actionError);
      this.renderAndEmit();
    } finally {
      if (!this.isLifecycleCurrent(lifecycle)) {
        return;
      }

      this.state.requestBusy = false;
      this.renderAndEmit();
    }
  }

  private async resumeOrStart(): Promise<void> {
    const selectedEditionDate = getSelectedEditionDate();
    if (
      this.state.daily?.date &&
      this.state.daily.date !== selectedEditionDate
    ) {
      await this.startSession({ editionDate: selectedEditionDate });
      return;
    }

    if (this.isDailyLockedOut()) {
      this.clearQueuedPlaySceneAnimation();
      this.playScene.clearLocalAnimation();
      this.stopLocalAnimationLoop();
      this.state.scene = "win";
      this.state.error = null;
      this.renderAndEmit();
      return;
    }

    if (!this.state.session) {
      await this.startSession({ editionDate: selectedEditionDate });
      return;
    }

    this.clearQueuedPlaySceneAnimation();
    this.playScene.clearLocalAnimation();
    this.stopLocalAnimationLoop();
    this.state.scene = getSceneForSession(this.state.session);
    this.state.error = null;
    this.renderAndEmit();
  }

  private async resetSession(options?: {
    revealScene?: boolean;
  }): Promise<void> {
    const selectedEditionDate = getSelectedEditionDate();
    if (
      this.state.daily?.date &&
      this.state.daily.date !== selectedEditionDate
    ) {
      await this.startSession({
        revealScene: options?.revealScene ?? true,
        editionDate: selectedEditionDate,
      });
      return;
    }

    if (this.isDailyLockedOut()) {
      this.clearQueuedPlaySceneAnimation();
      this.playScene.clearLocalAnimation();
      this.stopLocalAnimationLoop();
      this.state.scene = "win";
      this.state.error = null;
      this.renderAndEmit();
      return;
    }

    if (this.state.session) {
      await this.runGameAction("RESET", {}, options);
      return;
    }

    await this.startSession({
      revealScene: options?.revealScene ?? true,
      editionDate: selectedEditionDate,
    });
  }

  private enterHelpMenu(clearError: boolean = false): void {
    this.clearQueuedSceneAfterRender();
    this.clearQueuedPlaySceneAnimation();
    this.playScene.clearLocalAnimation();
    this.stopLocalAnimationLoop();
    this.state.scene = "help";
    this.helpScene.onEnter();
    if (clearError) {
      this.state.error = null;
    }
    this.renderAndEmit();
  }

  private async activateMenuAction(action: MenuActionId): Promise<void> {
    if (action === "play") {
      await this.resumeOrStart();
      return;
    }

    if (action === "about") {
      this.clearQueuedSceneAfterRender();
      this.clearQueuedPlaySceneAnimation();
      this.playScene.clearLocalAnimation();
      this.stopLocalAnimationLoop();
      this.state.scene = "about";
      this.aboutScene.onEnter();
      this.renderAndEmit();
      return;
    }

    this.enterHelpMenu();
  }

  private pulseClickCursor(point: HoverPoint): void {
    this.stopClickPulse();
    this.state.clickPoint = point;
    this.renderAndEmit();

    this.clickPulseTimerId = this.scheduler.setTimeout(() => {
      if (this.disposed) {
        return;
      }

      this.clickPulseTimerId = null;
      this.state.clickPoint = null;
      this.renderAndEmit();
    }, this.timings.clickPulseMs);
  }
}
