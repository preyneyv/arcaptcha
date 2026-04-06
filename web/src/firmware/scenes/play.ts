import type { ActionName } from "../../lib/api";
import { drawText, measureText } from "../font";
import {
  blitArcGrid,
  clearFramebuffer,
  createFramebuffer,
  drawGridCursor,
  fillRect,
  GAMEPLAY_HEIGHT,
  GAMEPLAY_SCALE,
  SCREEN_WIDTH,
  setPixel,
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

const STATUS_BAND_COLORS: Record<PostGameBand, number> = {
  red: 8,
  yellow: 11,
  green: 14,
  blue: 9,
  neutral: 10,
};

const FILLED_CIRCLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -2],
  [-1, -1],
  [0, -1],
  [1, -1],
  [-2, 0],
  [-1, 0],
  [0, 0],
  [1, 0],
  [2, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
  [0, 2],
];

const HOLLOW_CIRCLE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, -2],
  [-1, -1],
  [1, -1],
  [-2, 0],
  [2, 0],
  [-1, 1],
  [1, 1],
  [0, 2],
];

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

function drawTextRight(
  framebuffer: ReturnType<typeof createFramebuffer>,
  right: number,
  y: number,
  text: string,
  color: number,
): void {
  drawText(
    framebuffer,
    right - measureText(text, "small"),
    y,
    text,
    color,
    "small",
  );
}

function drawStatusCircle(
  framebuffer: ReturnType<typeof createFramebuffer>,
  centerX: number,
  centerY: number,
  color: number,
  filled: boolean,
): void {
  const offsets = filled ? FILLED_CIRCLE_OFFSETS : HOLLOW_CIRCLE_OFFSETS;
  for (const [offsetX, offsetY] of offsets) {
    setPixel(framebuffer, centerX + offsetX, centerY + offsetY, color);
  }
}

function drawPerformanceCircles(
  framebuffer: ReturnType<typeof createFramebuffer>,
  model: FirmwareModel,
  progress: string,
): void {
  const goal = Math.max(
    1,
    model.session?.winLevels || model.session?.levelsCompleted || 1,
  );
  const completed = Math.max(
    0,
    Math.min(model.session?.levelsCompleted ?? 0, goal),
  );
  const progressWidth = measureText(progress, "small");
  const left = 4;
  const right = SCREEN_WIDTH - progressWidth - 8;
  const centerY = 133;
  const levelActionCounts = model.session?.levelActionCounts ?? [];
  const baselineActionsByLevel = model.daily?.baselineActions ?? [];
  const pendingColor = UI_COLORS.border;

  if (right <= left) {
    return;
  }

  if (goal === 1) {
    const scorePercent = getLevelScorePercent(
      levelActionCounts[0],
      baselineActionsByLevel[0],
    );
    const completedColor = STATUS_BAND_COLORS[getPerformanceBand(scorePercent)];
    drawStatusCircle(
      framebuffer,
      Math.floor((left + right) / 2),
      centerY,
      completed > 0 ? completedColor : pendingColor,
      completed > 0,
    );
    return;
  }

  for (let index = 0; index < goal; index += 1) {
    const centerX =
      left + Math.floor((index * (right - left)) / Math.max(1, goal - 1));
    const isComplete = index < completed;
    const scorePercent = getLevelScorePercent(
      levelActionCounts[index],
      baselineActionsByLevel[index],
    );
    const completedColor = STATUS_BAND_COLORS[getPerformanceBand(scorePercent)];
    drawStatusCircle(
      framebuffer,
      centerX,
      centerY,
      isComplete ? completedColor : pendingColor,
      isComplete,
    );
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
  onEnter(): void {}

  getSelection(): number | null {
    return null;
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
    const progress = `${model.session?.levelsCompleted ?? 0}/${goal}`;
    drawPerformanceCircles(framebuffer, model, progress);
    drawTextRight(
      framebuffer,
      SCREEN_WIDTH - 2,
      131,
      progress,
      UI_COLORS.textInverse,
    );

    return {
      framebuffer,
      controls,
      hotspots: [],
      scene: "play",
    };
  }
}
