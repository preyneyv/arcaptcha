import copy from "copy-to-clipboard";
import {
  ApiRequestError,
  type ActionName,
  type CommandFrame,
  type DailyPuzzle,
  type PlaySession,
} from "../lib/api";
import {
  clearPersistedRunState,
  readPersistedRunState,
  writePersistedRunState,
  type PersistedRunSessionState,
  type PersistedRunState,
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

type BackendActionName = Exclude<ActionName, "HELP">;

interface RuntimeSession {
  cardId: string;
  gameId: string;
  guid: string | null;
  state: string;
  frames: number[][][];
  grid: number[][];
  availableActions: ActionName[];
  countedActions: number;
  levelsCompleted: number;
  winLevels: number;
  levelActionCounts: number[];
  currentLevelStartActionCount: number;
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
  fetchDailyPuzzle(): Promise<DailyPuzzle>;
  openPlaySession(
    gameId: string,
  ): Promise<{ session: PlaySession; frame: CommandFrame }>;
  validatePlaySession(session: PlaySession): Promise<void>;
  sendAction(
    action: BackendActionName,
    session: PlaySession,
    extraData?: Record<string, unknown>,
  ): Promise<CommandFrame>;
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

const INTER_LEVEL_WIPE_COLOR = 14;
const INTER_LEVEL_WIPE_BAND_ROWS = 3;
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

function isIosOrAndroidPlatform(): boolean {
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

function isSessionIdentityError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.status === 404 ||
    message.includes("not found") ||
    message.includes("missing `guid`") ||
    message.includes("does not match api key") ||
    message.includes("has not been started")
  );
}

function toPlaySession(session: RuntimeSession): PlaySession {
  return {
    cardId: session.cardId,
    gameId: session.gameId,
    guid: session.guid,
  };
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
    cardId: session.cardId,
    gameId: session.gameId,
    guid: session.guid,
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
  };
}

function toRuntimeSessionFromPersisted(
  persistedSession: PersistedRunSessionState,
): RuntimeSession {
  return {
    cardId: persistedSession.cardId,
    gameId: persistedSession.gameId,
    guid: persistedSession.guid,
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
  private readonly playScene = new PlaySceneModule();
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
  private startSessionPromise: Promise<void> | null = null;
  private pendingSessionReveal = false;
  private playbackTimerId: number | null = null;
  private clickPulseTimerId: number | null = null;
  private sceneTransitionTimerId: number | null = null;
  private sceneTransitionFrom: Framebuffer | null = null;
  private sceneTransitionTarget: SceneKind | null = null;
  private sceneTransitionStartMs = 0;
  private interLevelTransitionTimerId: number | null = null;
  private interLevelTransitionFrom: Framebuffer | null = null;
  private interLevelTransitionStartMs = 0;
  private winCountdownTimerId: number | null = null;
  private pendingInterLevelTransitionFrom: Framebuffer | null = null;
  private pendingInterLevelTransitionAfterPlayback = false;
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
        this.state.daily = await this.api.fetchDailyPuzzle();
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.state.error = null;
      } catch (loadError) {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.state.error = getErrorMessage(loadError);
      } finally {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.state.booting = false;
        this.renderAndEmit();
      }

      if (
        this.isLifecycleCurrent(lifecycle) &&
        this.state.daily &&
        !this.state.error
      ) {
        const restored = await this.restorePersistedRun(lifecycle);
        if (!this.isLifecycleCurrent(lifecycle) || restored) {
          return;
        }

        await this.startSession({ revealScene: false });
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
    this.stopSceneTransition();
    this.stopInterLevelTransition();
    this.stopWinCountdown();
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
    return this.state.requestBusy || this.state.playbackBusy;
  }

  private isLifecycleCurrent(lifecycle: number): boolean {
    return !this.disposed && this.lifecycleId === lifecycle;
  }

  private isDailyLockedOut(): boolean {
    const dailyDate = this.state.daily?.date;
    return Boolean(dailyDate && this.state.lockedDailyDate === dailyDate);
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
        version: 1,
        dailyDate,
        status: "completed",
        session: sessionState,
        completedAt: new Date().toISOString(),
      });
      this.state.lockedDailyDate = dailyDate;
      return;
    }

    writePersistedRunState({
      version: 1,
      dailyDate,
      status: "in_progress",
      session: sessionState,
    });
  }

  private async resumePersistedInProgressRun(
    persisted: PersistedRunState,
    lifecycle: number,
  ): Promise<boolean> {
    this.state.requestBusy = true;
    this.renderAndEmit();

    try {
      await this.api.validatePlaySession({
        cardId: persisted.session.cardId,
        gameId: persisted.session.gameId,
        guid: persisted.session.guid,
      });
      if (!this.isLifecycleCurrent(lifecycle)) {
        return true;
      }

      const resumedSession = toRuntimeSessionFromPersisted(persisted.session);
      if (
        resumedSession.grid.length === 0 ||
        resumedSession.availableActions.length === 0
      ) {
        clearPersistedRunState();
        this.state.lockedDailyDate = null;
        return false;
      }

      this.syncSession(resumedSession);
      this.state.scene = getSceneForSession(resumedSession);
      this.state.error = null;
      this.renderAndEmit();
      return true;
    } catch (resumeError) {
      if (!this.isLifecycleCurrent(lifecycle)) {
        return true;
      }

      if (isSessionIdentityError(resumeError)) {
        clearPersistedRunState();
        this.state.lockedDailyDate = null;
        return false;
      }

      this.state.error = getErrorMessage(resumeError);
      this.renderAndEmit();
      return true;
    } finally {
      if (this.isLifecycleCurrent(lifecycle)) {
        this.state.requestBusy = false;
        this.renderAndEmit();
      }
    }
  }

  private async restorePersistedRun(lifecycle: number): Promise<boolean> {
    const dailyDate = this.state.daily?.date;
    if (!dailyDate) {
      return false;
    }

    const persisted = readPersistedRunState();
    if (!persisted) {
      this.state.lockedDailyDate = null;
      return false;
    }

    if (persisted.dailyDate !== dailyDate) {
      clearPersistedRunState();
      this.state.lockedDailyDate = null;
      return false;
    }

    if (persisted.status === "completed") {
      const restoredSession = toRuntimeSessionFromPersisted(persisted.session);
      this.syncSession(restoredSession);
      this.state.lockedDailyDate = dailyDate;
      this.state.scene = "win";
      this.state.error = null;
      this.renderAndEmit();
      return true;
    }

    return this.resumePersistedInProgressRun(persisted, lifecycle);
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
    this.stopInterLevelTransition();
    this.clearQueuedInterLevelTransition();

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

  private startInterLevelTransition(from: Framebuffer): void {
    if (this.timings.interLevelTransitionMs <= 0) {
      return;
    }

    this.interLevelTransitionFrom = new Uint8Array(from);
    this.interLevelTransitionStartMs = Date.now();

    if (this.interLevelTransitionTimerId !== null) {
      return;
    }

    this.interLevelTransitionTimerId = this.scheduler.setInterval(() => {
      if (this.disposed) {
        return;
      }

      this.renderAndEmit();
    }, 1000 / 60);
  }

  private stopInterLevelTransition(): void {
    this.scheduler.clearInterval(this.interLevelTransitionTimerId);
    this.interLevelTransitionTimerId = null;
    this.interLevelTransitionFrom = null;
    this.interLevelTransitionStartMs = 0;
  }

  private queueInterLevelTransition(from: Framebuffer): void {
    this.pendingInterLevelTransitionFrom = new Uint8Array(from);
    this.pendingInterLevelTransitionAfterPlayback = true;
  }

  private clearQueuedInterLevelTransition(): void {
    this.pendingInterLevelTransitionFrom = null;
    this.pendingInterLevelTransitionAfterPlayback = false;
  }

  private startQueuedInterLevelTransitionIfReady(): void {
    if (
      !this.pendingInterLevelTransitionAfterPlayback ||
      this.pendingInterLevelTransitionFrom === null
    ) {
      return;
    }

    if (this.state.scene !== "play" || this.state.error) {
      this.clearQueuedInterLevelTransition();
      return;
    }

    this.startInterLevelTransition(this.pendingInterLevelTransitionFrom);
    this.clearQueuedInterLevelTransition();
  }

  private createInterLevelTransitionFrame(
    from: Framebuffer,
    to: FirmwareFrame,
    progress: number,
  ): FirmwareFrame {
    const composited = new Uint8Array(to.framebuffer);
    const revealRows = Math.max(
      0,
      Math.min(GAMEPLAY_HEIGHT, Math.floor(GAMEPLAY_HEIGHT * progress)),
    );

    for (let y = revealRows; y < GAMEPLAY_HEIGHT; y += 1) {
      const rowOffset = y * SCREEN_WIDTH;
      for (let x = 0; x < SCREEN_WIDTH; x += 1) {
        composited[rowOffset + x] = from[rowOffset + x] ?? 0;
      }
    }

    const bandStart = Math.max(0, revealRows - INTER_LEVEL_WIPE_BAND_ROWS);
    const bandEnd = Math.min(
      GAMEPLAY_HEIGHT,
      revealRows + INTER_LEVEL_WIPE_BAND_ROWS,
    );
    for (let y = bandStart; y < bandEnd; y += 1) {
      const rowOffset = y * SCREEN_WIDTH;
      for (let x = 0; x < SCREEN_WIDTH; x += 1) {
        composited[rowOffset + x] = INTER_LEVEL_WIPE_COLOR;
      }
    }

    return {
      ...to,
      framebuffer: composited,
    };
  }

  private applyInterLevelTransition(nextFrame: FirmwareFrame): FirmwareFrame {
    if (this.interLevelTransitionFrom === null) {
      return nextFrame;
    }

    if (nextFrame.scene !== "play") {
      this.stopInterLevelTransition();
      return nextFrame;
    }

    const elapsedMs = Date.now() - this.interLevelTransitionStartMs;
    const progress = Math.min(
      1,
      elapsedMs / this.timings.interLevelTransitionMs,
    );

    if (progress >= 1) {
      this.stopInterLevelTransition();
      return nextFrame;
    }

    return this.createInterLevelTransitionFrame(
      this.interLevelTransitionFrom,
      nextFrame,
      progress,
    );
  }

  private createSceneTransitionFrame(
    from: Framebuffer,
    to: FirmwareFrame,
    progress: number,
  ): FirmwareFrame {
    const composited = new Uint8Array(from);
    const revealWidth = Math.max(
      0,
      Math.min(SCREEN_WIDTH, Math.floor(SCREEN_WIDTH * progress)),
    );

    for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
      const rowOffset = y * SCREEN_WIDTH;
      for (let x = 0; x < revealWidth; x += 1) {
        composited[rowOffset + x] = to.framebuffer[rowOffset + x] ?? 0;
      }
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

    nextFrame = this.applySceneTransition(nextFrame);
    nextFrame = this.applyInterLevelTransition(nextFrame);

    this.latestFrame = nextFrame;
    this.syncWinCountdown(this.latestFrame.scene === "win");
    this.snapshot = this.buildSnapshot(this.latestFrame);
    this.emit("snapshot", this.snapshot);
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
    }, 1000);
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
    this.clearQueuedInterLevelTransition();
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
      this.stopInterLevelTransition();
      this.state.displayGrid = null;
      return;
    }

    this.state.displayGrid = frames[0] ?? null;
    if (shouldStartInterLevelTransition) {
      if (frames.length > 1) {
        this.queueInterLevelTransition(this.latestFrame.framebuffer);
      } else {
        this.startInterLevelTransition(this.latestFrame.framebuffer);
      }
    }

    if (frames.length === 1) {
      return;
    }

    this.state.playbackBusy = true;
    let frameIndex = 0;
    this.playbackTimerId = this.scheduler.setInterval(() => {
      if (this.disposed) {
        return;
      }

      frameIndex += 1;
      this.state.displayGrid =
        frames[Math.min(frameIndex, frames.length - 1)] ?? null;

      if (frameIndex >= frames.length - 1) {
        this.stopPlayback();
        this.startQueuedInterLevelTransitionIfReady();
      }

      this.renderAndEmit();
    }, this.timings.framePlaybackMs);
  }

  private async startSession(options?: {
    revealScene?: boolean;
  }): Promise<void> {
    if (this.isDailyLockedOut()) {
      this.state.scene = "win";
      this.state.error = null;
      this.renderAndEmit();
      return;
    }

    if (!this.state.daily) {
      return;
    }

    const revealScene = options?.revealScene ?? true;
    if (revealScene) {
      this.pendingSessionReveal = true;
    }

    if (this.startSessionPromise) {
      await this.startSessionPromise;
      return;
    }

    const lifecycle = this.lifecycleId;
    const startTask = (async () => {
      this.state.requestBusy = true;
      this.renderAndEmit();

      try {
        const opened = await this.api.openPlaySession(
          this.state.daily?.resolvedGameId || this.state.daily?.gameId || "",
        );
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        const shouldReveal = this.pendingSessionReveal;
        const openedSession: RuntimeSession = {
          cardId: opened.session.cardId,
          gameId: opened.session.gameId,
          guid: opened.frame.guid,
          state: opened.frame.state,
          frames: opened.frame.frame,
          grid: opened.frame.grid,
          availableActions: opened.frame.availableActions,
          countedActions: 1,
          levelsCompleted: opened.frame.levelsCompleted,
          winLevels: opened.frame.winLevels,
          levelActionCounts: [],
          currentLevelStartActionCount: 1,
        };
        this.syncSession(openedSession);
        if (shouldReveal) {
          this.state.scene = getSceneForSession(openedSession);
        }
        this.state.error = null;
        this.renderAndEmit();
      } catch (sessionError) {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.syncSession(null);
        this.state.scene = "help";
        this.helpScene.onEnter();
        this.state.error = getErrorMessage(sessionError);
        this.renderAndEmit();
      } finally {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.pendingSessionReveal = false;
        this.state.requestBusy = false;
        this.renderAndEmit();
      }
    })();

    this.startSessionPromise = startTask;
    try {
      await startTask;
    } finally {
      if (this.startSessionPromise === startTask) {
        this.startSessionPromise = null;
      }
    }
  }

  private async runGameAction(
    action: BackendActionName,
    extraData: Record<string, unknown> = {},
    options?: { revealScene?: boolean },
  ): Promise<void> {
    if (this.isDailyLockedOut()) {
      this.state.scene = "win";
      this.renderAndEmit();
      return;
    }

    const activeSession = this.state.session;
    if (!activeSession) {
      await this.startSession();
      return;
    }

    const lifecycle = this.lifecycleId;
    this.state.requestBusy = true;
    this.renderAndEmit();

    try {
      const nextFrame = await this.api.sendAction(
        action,
        toPlaySession(activeSession),
        extraData,
      );
      if (!this.isLifecycleCurrent(lifecycle)) {
        return;
      }

      const nextSession: RuntimeSession = {
        ...activeSession,
        gameId: preferSessionGameId(activeSession.gameId, nextFrame.gameId),
        guid: nextFrame.guid,
        state: nextFrame.state,
        frames: nextFrame.frame,
        grid: nextFrame.grid,
        availableActions: nextFrame.availableActions,
        countedActions:
          action === "RESET" ? 1 : activeSession.countedActions + 1,
        levelsCompleted: nextFrame.levelsCompleted,
        winLevels: nextFrame.winLevels,
        ...(action === "RESET"
          ? {
              levelActionCounts: [],
              currentLevelStartActionCount: 1,
            }
          : deriveLevelActionCounts(
              activeSession,
              activeSession.countedActions + 1,
              nextFrame.levelsCompleted,
            )),
      };
      this.syncSession(nextSession);
      this.state.error = null;
      if (options?.revealScene ?? this.state.scene !== "help") {
        this.state.scene = getSceneForSession(nextSession);
      }
      this.renderAndEmit();
    } catch (actionError) {
      if (!this.isLifecycleCurrent(lifecycle)) {
        return;
      }

      if (isSessionIdentityError(actionError)) {
        this.syncSession(null);
        this.state.scene = "help";
        this.helpScene.onEnter();
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
    if (this.isDailyLockedOut()) {
      this.state.scene = "win";
      this.state.error = null;
      this.renderAndEmit();
      return;
    }

    if (!this.state.session) {
      await this.startSession();
      return;
    }

    this.state.scene = getSceneForSession(this.state.session);
    this.state.error = null;
    this.renderAndEmit();
  }

  private async resetSession(options?: {
    revealScene?: boolean;
  }): Promise<void> {
    if (this.isDailyLockedOut()) {
      this.state.scene = "win";
      this.state.error = null;
      this.renderAndEmit();
      return;
    }

    if (this.state.session) {
      await this.runGameAction("RESET", {}, options);
      return;
    }

    await this.startSession({ revealScene: options?.revealScene ?? true });
  }

  private enterHelpMenu(clearError: boolean = false): void {
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
