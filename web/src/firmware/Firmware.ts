import {
  ApiRequestError,
  type ActionName,
  type CommandFrame,
  type DailyPuzzle,
  type PlaySession,
} from "../lib/api";
import {
  GAMEPLAY_HEIGHT,
  GAMEPLAY_SCALE,
  type Framebuffer,
} from "./framebuffer";
import {
  findHotspot,
  getNextHelpSelection,
  renderFirmware,
  type ControlState,
  type FirmwareFrame,
  type FirmwareModel,
  type HelpLink,
  type HoverPoint,
  type SceneKind,
  type SessionSnapshot,
} from "./os";

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
}

interface FirmwareState {
  daily: DailyPuzzle | null;
  session: RuntimeSession | null;
  scene: SceneKind;
  booting: boolean;
  requestBusy: boolean;
  playbackBusy: boolean;
  error: string | null;
  startedOnce: boolean;
  blinkVisible: boolean;
  helpSelection: number | null;
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
  "open-url": { href: string };
}

export interface FirmwareApi {
  fetchDailyPuzzle(): Promise<DailyPuzzle>;
  openPlaySession(
    gameId: string,
  ): Promise<{ session: PlaySession; frame: CommandFrame }>;
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
  blinkMs: number;
  framePlaybackMs: number;
  clickPulseMs: number;
}

export interface FirmwareDeps {
  api: FirmwareApi;
  helpLinks: readonly HelpLink[];
  ensurePlayerId?: () => string;
  scheduler?: FirmwareScheduler;
  timings?: Partial<FirmwareTimings>;
}

type FirmwareListeners = {
  [K in keyof FirmwareEventMap]: Set<(payload: FirmwareEventMap[K]) => void>;
};

const DEFAULT_TIMINGS: FirmwareTimings = {
  blinkMs: 320,
  framePlaybackMs: 1000 / 24,
  clickPulseMs: 140,
};

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

function clampCoordinate(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  };
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
  private readonly helpLinks: readonly HelpLink[];
  private readonly scheduler: FirmwareScheduler;
  private readonly timings: FirmwareTimings;
  private readonly ensurePlayerId?: () => string;
  private readonly listeners: FirmwareListeners = {
    snapshot: new Set(),
    "open-url": new Set(),
  };

  private state: FirmwareState = {
    daily: null,
    session: null,
    scene: "help",
    booting: true,
    requestBusy: false,
    playbackBusy: false,
    error: null,
    startedOnce: false,
    blinkVisible: true,
    helpSelection: null,
    hoverPoint: null,
    clickPoint: null,
    displayGrid: null,
  };

  private snapshot: FirmwareSnapshot;
  private latestFrame: FirmwareFrame;
  private bootPromise: Promise<void> | null = null;
  private startSessionPromise: Promise<void> | null = null;
  private pendingSessionReveal = false;
  private blinkTimerId: number | null = null;
  private playbackTimerId: number | null = null;
  private clickPulseTimerId: number | null = null;
  private disposed = false;
  private lifecycleId = 0;

  constructor(deps: FirmwareDeps) {
    this.api = deps.api;
    this.helpLinks = deps.helpLinks;
    this.ensurePlayerId = deps.ensurePlayerId;
    this.scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
    this.timings = {
      ...DEFAULT_TIMINGS,
      ...deps.timings,
    };

    this.latestFrame = renderFirmware(this.buildModel());
    this.snapshot = this.buildSnapshot(this.latestFrame);
  }

  boot(): Promise<void> {
    if (this.disposed) {
      this.disposed = false;
    }

    if (this.bootPromise) {
      return this.bootPromise;
    }

    this.ensureBlinkTimer();
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
        void this.startSession({ revealScene: false });
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
    this.stopBlinkTimer();
    this.stopClickPulse();
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

  async dispatchAction(action: ActionName): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (action === "HELP") {
      this.state.scene = "help";
      this.state.error = null;
      this.renderAndEmit();
      return;
    }

    if (this.state.error) {
      if (action === "RESET") {
        await this.resetSession({ revealScene: true });
        return;
      }

      this.state.error = null;
      this.state.scene = "help";
      this.renderAndEmit();
      return;
    }

    if (this.state.scene === "help") {
      const canQueueSessionReveal =
        this.isInputLocked() && this.startSessionPromise !== null;

      if (
        this.isInputLocked() &&
        !canQueueSessionReveal &&
        action !== "ACTION1" &&
        action !== "ACTION2" &&
        action !== "ACTION3" &&
        action !== "ACTION4"
      ) {
        return;
      }

      if (action === "RESET") {
        await this.resetSession({ revealScene: true });
        return;
      }

      if (action === "ACTION1" || action === "ACTION3") {
        this.state.helpSelection = getNextHelpSelection(
          this.state.helpSelection,
          -1,
          this.helpLinks,
        );
        this.renderAndEmit();
        return;
      }

      if (action === "ACTION2" || action === "ACTION4") {
        this.state.helpSelection = getNextHelpSelection(
          this.state.helpSelection,
          1,
          this.helpLinks,
        );
        this.renderAndEmit();
        return;
      }

      if (action === "ACTION5") {
        if (this.state.helpSelection !== null) {
          this.openHelpLink(this.helpLinks[this.state.helpSelection]);
          return;
        }

        await this.resumeOrStart();
        return;
      }

      await this.resumeOrStart();
      return;
    }

    if (this.state.scene === "win") {
      if (action === "RESET") {
        await this.resetSession({ revealScene: true });
      }
      return;
    }

    if (!this.latestFrame.controls[action] || this.isInputLocked()) {
      return;
    }

    await this.runGameAction(action);
  }

  async pressScreen(point: HoverPoint): Promise<void> {
    if (this.disposed || this.state.error) {
      return;
    }

    if (this.state.scene === "help") {
      if (this.isInputLocked() && !this.startSessionPromise) {
        return;
      }

      const hotspot = findHotspot(this.latestFrame.hotspots, point.x, point.y);
      if (hotspot?.kind === "link") {
        this.openHelpLink(
          this.helpLinks.find((link) => link.id === hotspot.id),
        );
        return;
      }
      if (hotspot?.kind === "callback") {
        hotspot.callback();
        return;
      }

      await this.resumeOrStart();
      return;
    }

    if (
      this.state.scene !== "play" ||
      !this.state.session ||
      this.isInputLocked() ||
      !this.latestFrame.controls.ACTION6
    ) {
      return;
    }

    if (point.y >= GAMEPLAY_HEIGHT) {
      return;
    }

    this.pulseClickCursor(point);

    const targetX = clampCoordinate(
      Math.floor(point.x / GAMEPLAY_SCALE),
      0,
      63,
    );
    const targetY = clampCoordinate(
      Math.floor(point.y / GAMEPLAY_SCALE),
      0,
      63,
    );

    await this.runGameAction("ACTION6", {
      x: targetX,
      y: targetY,
    });
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
      session: toSessionSnapshot(this.state.session, this.state.displayGrid),
      hoverPoint: this.getPointInteractivity(this.state.hoverPoint)
        ? this.state.hoverPoint
        : null,
      clickPoint: this.state.clickPoint,
      busy: this.isInputLocked(),
      startedOnce: this.state.startedOnce,
      blinkVisible: this.state.blinkVisible,
      error: this.state.error,
      helpSelection: this.state.helpSelection,
      helpLinks: [...this.helpLinks],
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

  private renderAndEmit(): void {
    if (this.disposed) {
      return;
    }

    let nextFrame = renderFirmware(this.buildModel());
    if (this.state.hoverPoint && !this.canTrackHover(nextFrame)) {
      this.state.hoverPoint = null;
      nextFrame = renderFirmware(this.buildModel());
    }

    this.latestFrame = nextFrame;
    this.snapshot = this.buildSnapshot(this.latestFrame);
    this.emit("snapshot", this.snapshot);
  }

  private ensureBlinkTimer(): void {
    if (this.blinkTimerId !== null) {
      return;
    }

    this.blinkTimerId = this.scheduler.setInterval(() => {
      if (this.disposed) {
        return;
      }

      this.state.blinkVisible = !this.state.blinkVisible;
      this.renderAndEmit();
    }, this.timings.blinkMs);
  }

  private stopBlinkTimer(): void {
    this.scheduler.clearInterval(this.blinkTimerId);
    this.blinkTimerId = null;
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
    this.state.session = nextSession;

    const frames = getFrameSequence(nextSession);
    if (frames.length === 0) {
      this.state.displayGrid = null;
      return;
    }

    this.state.displayGrid = frames[0] ?? null;
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
      }

      this.renderAndEmit();
    }, this.timings.framePlaybackMs);
  }

  private async startSession(options?: {
    revealScene?: boolean;
  }): Promise<void> {
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
        this.syncSession({
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
        });
        if (shouldReveal) {
          this.state.scene = opened.frame.state === "WIN" ? "win" : "play";
          this.state.startedOnce = true;
          this.state.helpSelection = null;
        }
        this.state.error = null;
        this.renderAndEmit();
      } catch (sessionError) {
        if (!this.isLifecycleCurrent(lifecycle)) {
          return;
        }

        this.syncSession(null);
        this.state.scene = "help";
        this.state.helpSelection = null;
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

      this.syncSession({
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
      });
      this.state.startedOnce = true;
      this.state.error = null;
      if (options?.revealScene ?? this.state.scene !== "help") {
        this.state.scene = nextFrame.state === "WIN" ? "win" : "play";
        this.state.helpSelection = null;
      }
      this.renderAndEmit();
    } catch (actionError) {
      if (!this.isLifecycleCurrent(lifecycle)) {
        return;
      }

      if (isSessionIdentityError(actionError)) {
        this.syncSession(null);
        this.state.scene = "help";
        this.state.helpSelection = null;
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
    if (!this.state.session) {
      await this.startSession();
      return;
    }

    this.state.scene = this.state.session.state === "WIN" ? "win" : "play";
    this.state.startedOnce = true;
    this.state.error = null;
    this.state.helpSelection = null;
    this.renderAndEmit();
  }

  private async resetSession(options?: {
    revealScene?: boolean;
  }): Promise<void> {
    if (this.state.session) {
      await this.runGameAction("RESET", {}, options);
      return;
    }

    await this.startSession({ revealScene: options?.revealScene ?? true });
  }

  private openHelpLink(link: HelpLink | undefined): void {
    if (!link?.href) {
      return;
    }

    this.emit("open-url", { href: link.href });
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
