import type { ActionName } from "../../lib/api";
import { drawText, drawTextRight, measureText } from "../font";
import {
  blitArcGrid,
  clearFramebuffer,
  createFramebuffer,
  drawGridCursor,
  fillRect,
  GAMEPLAY_HEIGHT,
  GAMEPLAY_SCALE,
  SCREEN_WIDTH,
  strokeRect,
  type Framebuffer,
} from "../framebuffer";
import {
  getLevelScorePercent,
  getPerformanceBand,
  type ControlState,
  type FirmwareFrame,
  type FirmwareModel,
  type HoverPoint,
  type PostGameBand,
} from "../os";
import { UI_COLORS } from "../palette";
import type { SceneContext, SceneModule } from "./base";

const INTER_LEVEL_WIPE_COLOR = 14;
const INTER_LEVEL_WIPE_BAND_ROWS = 3;

const STATUS_BAND_COLORS: Record<PostGameBand, number> = {
  red: 8,
  yellow: 11,
  green: 14,
  blue: 9,
  neutral: 3,
};

function createControlState(defaultValue: boolean = false): ControlState {
  return {
    ACTION1: defaultValue,
    ACTION2: defaultValue,
    ACTION3: defaultValue,
    ACTION4: defaultValue,
    ACTION5: defaultValue,
    ACTION6: defaultValue,
    ACTION7: defaultValue,
    HELP: defaultValue,
    RESET: defaultValue,
  };
}

function drawPerformanceHeatmap(
  framebuffer: ReturnType<typeof createFramebuffer>,
  model: FirmwareModel,
  progress: string,
): void {
  const tileSize = 7;
  const tileGap = 2;
  const startX = 2;
  const y = GAMEPLAY_HEIGHT + 3;

  const goal = Math.max(
    1,
    model.session?.winLevels || model.session?.levelsCompleted || 1,
  );
  const completed = Math.max(
    0,
    Math.min(model.session?.levelsCompleted ?? 0, goal),
  );

  const progressWidth = measureText(progress);
  const maxHeatmapWidth = SCREEN_WIDTH - progressWidth - 8 - startX;
  const levelActionCounts = model.session?.levelActionCounts ?? [];
  const baselineActionsByLevel = model.daily?.baselineActions ?? [];
  const pendingColor = STATUS_BAND_COLORS.neutral;

  const totalWidth = goal * tileSize + Math.max(0, goal - 1) * tileGap;
  if (maxHeatmapWidth <= 0 || totalWidth > maxHeatmapWidth) {
    return;
  }

  for (let index = 0; index < goal; index += 1) {
    const x = startX + index * (tileSize + tileGap);
    const isComplete = index < completed;
    const scorePercent = getLevelScorePercent(
      levelActionCounts[index],
      baselineActionsByLevel[index],
    );
    const color = isComplete
      ? STATUS_BAND_COLORS[getPerformanceBand(scorePercent)]
      : pendingColor;

    if (isComplete) {
      fillRect(framebuffer, x, y, tileSize, tileSize, color);
    } else {
      strokeRect(framebuffer, x, y, tileSize, tileSize, color);
    }
  }
}

function buildGameplayControls(model: FirmwareModel): ControlState {
  const controls = createControlState(false);
  controls.HELP = true;

  if (!model.daily) {
    return controls;
  }

  controls.RESET = true;

  if (!model.session) {
    return controls;
  }

  for (const action of model.session.availableActions) {
    if (action !== "HELP") {
      controls[action] = true;
    }
  }

  return controls;
}

function clampCoordinate(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class PlaySceneModule implements SceneModule {
  private interLevelTransitionFrom: Framebuffer | null = null;
  private interLevelTransitionStartMs = 0;

  constructor(private readonly interLevelTransitionMs: number = 280) {}

  onEnter(): void {
    this.clearLocalAnimation();
  }

  getSelection(): number | null {
    return null;
  }

  beginLocalAnimation(from: Framebuffer): void {
    if (this.interLevelTransitionMs <= 0) {
      return;
    }

    this.interLevelTransitionFrom = new Uint8Array(from);
    this.interLevelTransitionStartMs = Date.now();
  }

  hasActiveLocalAnimation(): boolean {
    return this.interLevelTransitionFrom !== null;
  }

  clearLocalAnimation(): void {
    this.interLevelTransitionFrom = null;
    this.interLevelTransitionStartMs = 0;
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

    const elapsedMs = Date.now() - this.interLevelTransitionStartMs;
    const progress = Math.min(1, elapsedMs / this.interLevelTransitionMs);

    if (progress >= 1) {
      this.clearLocalAnimation();
      return nextFrame;
    }

    return this.createInterLevelTransitionFrame(
      this.interLevelTransitionFrom,
      nextFrame,
      progress,
    );
  }

  async dispatchAction(
    action: ActionName,
    context: SceneContext,
  ): Promise<void> {
    if (action === "HELP") {
      return;
    }

    if (!context.canDispatchGameplayAction(action) || context.isInputLocked()) {
      return;
    }

    await context.runGameplayAction(action);
  }

  async pressScreen(
    point: HoverPoint,
    frame: FirmwareFrame,
    context: SceneContext,
  ): Promise<void> {
    if (
      !context.hasSession() ||
      context.isInputLocked() ||
      !frame.controls.ACTION6
    ) {
      return;
    }

    if (point.y >= GAMEPLAY_HEIGHT) {
      return;
    }

    context.pulseClickCursor(point);

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

    await context.runGameplayAction("ACTION6", {
      x: targetX,
      y: targetY,
    });
  }

  render(model: FirmwareModel): FirmwareFrame {
    const framebuffer = createFramebuffer(UI_COLORS.backgroundStrong);
    const controls = buildGameplayControls(model);

    clearFramebuffer(framebuffer, UI_COLORS.backgroundStrong);

    if (model.session?.grid.length) {
      blitArcGrid(framebuffer, model.session.grid);
      const cursorPoint = model.clickPoint ?? model.hoverPoint;
      if (
        controls.ACTION6 &&
        cursorPoint &&
        cursorPoint.y < GAMEPLAY_HEIGHT &&
        (!model.busy || model.clickPoint)
      ) {
        const maxCellX = Math.floor((SCREEN_WIDTH - 1) / GAMEPLAY_SCALE);
        const maxCellY = Math.floor((GAMEPLAY_HEIGHT - 1) / GAMEPLAY_SCALE);
        const cellX = Math.floor(cursorPoint.x / GAMEPLAY_SCALE);
        const cellY = Math.floor(cursorPoint.y / GAMEPLAY_SCALE);
        drawGridCursor(
          framebuffer,
          Math.max(0, Math.min(maxCellX, cellX)),
          Math.max(0, Math.min(maxCellY, cellY)),
          UI_COLORS.warning,
          model.clickPoint ? 2 : 1,
        );
      }
    } else {
      fillRect(
        framebuffer,
        0,
        0,
        SCREEN_WIDTH,
        GAMEPLAY_HEIGHT,
        UI_COLORS.background,
      );
      drawText(framebuffer, 20, 58, "NO FRAME", UI_COLORS.text, "large");
    }

    fillRect(
      framebuffer,
      0,
      GAMEPLAY_HEIGHT,
      SCREEN_WIDTH,
      12,
      UI_COLORS.background,
    );
    fillRect(
      framebuffer,
      0,
      GAMEPLAY_HEIGHT,
      SCREEN_WIDTH,
      1,
      UI_COLORS.border,
    );
    const goal =
      model.session?.winLevels || model.session?.levelsCompleted || 1;
    const progress = `${model.session?.countedActions}`;
    drawTextRight(
      framebuffer,
      SCREEN_WIDTH - 2,
      GAMEPLAY_HEIGHT + 4,
      progress,
      UI_COLORS.text,
      "small",
    );
    drawPerformanceHeatmap(framebuffer, model, progress);

    return this.applyInterLevelTransition({
      framebuffer,
      controls,
      hotspots: [],
      scene: "play",
    });
  }
}
