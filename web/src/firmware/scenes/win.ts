import type { ActionName } from "../../lib/api";
import { drawText, drawTextCenter, drawTextRight } from "../font";
import {
  blitSprite,
  clearFramebuffer,
  createFramebuffer,
  fillRect,
  SCREEN_WIDTH,
} from "../framebuffer";
import type {
  ControlState,
  FirmwareFrame,
  FirmwareModel,
  HoverPoint,
  PostGameBand,
  PostGameStats,
} from "../os";
import { UI_COLORS } from "../palette";
import {
  SPRITE_RESULTS_FOOTER,
  SPRITE_RESULTS_HEADER_LOSE,
  SPRITE_RESULTS_HEADER_WIN,
} from "../sprites";
import type { SceneContext, SceneModule } from "./base";

const BAND_COLORS: Record<PostGameBand, number> = {
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

function buildWinControls(model: FirmwareModel): ControlState {
  const controls = createControlState(false);
  controls.HELP = true;
  controls.RESET = Boolean(model.daily) && !model.dailyLocked;
  return controls;
}

function drawLevelHeatmap(
  framebuffer: ReturnType<typeof createFramebuffer>,
  stats: PostGameStats,
): void {
  if (stats.levelMetrics.length === 0) {
    return;
  }

  const tileSize = 8;
  const tileGap = 3;
  const totalWidth =
    stats.levelMetrics.length * tileSize +
    Math.max(0, stats.levelMetrics.length - 1) * tileGap;
  const startX = Math.max(4, Math.floor((SCREEN_WIDTH - totalWidth) / 2));
  const y = 80;

  stats.levelMetrics.forEach((metric, index) => {
    const x = startX + index * (tileSize + tileGap);
    fillRect(framebuffer, x, y, tileSize, tileSize, BAND_COLORS[metric.band]);
  });
}

export class WinSceneModule implements SceneModule {
  onEnter(): void {}

  getSelection(): number | null {
    return null;
  }

  async dispatchAction(
    action: ActionName,
    context: SceneContext,
  ): Promise<void> {
    if (action === "RESET" && context.canDispatchGameplayAction("RESET")) {
      await context.resetSession({ revealScene: true });
      return;
    }

    if (action === "HELP") {
      context.enterHelpMenu(true);
    }
  }

  async pressScreen(
    _point: HoverPoint,
    _frame: FirmwareFrame,
    _context: SceneContext,
  ): Promise<void> {}

  render(model: FirmwareModel): FirmwareFrame {
    const framebuffer = createFramebuffer(UI_COLORS.background);
    const stats = model.postGame;

    clearFramebuffer(framebuffer, UI_COLORS.background);

    if (!stats) {
      drawText(framebuffer, 22, 58, "POST GAME", UI_COLORS.text, "large");
      drawText(framebuffer, 28, 72, "NO DATA", UI_COLORS.textMuted, "large");
      return {
        framebuffer,
        controls: buildWinControls(model),
        hotspots: [],
        scene: "win",
      };
    }

    blitSprite(
      framebuffer,
      stats.outcome === "win"
        ? SPRITE_RESULTS_HEADER_WIN
        : SPRITE_RESULTS_HEADER_LOSE,
    );

    drawText(
      framebuffer,
      4,
      47,
      `${stats.scorePercent}`,
      UI_COLORS.text,
      "large",
    );

    drawTextCenter(
      framebuffer,
      64,
      47,
      `${stats.countedActions}`,
      UI_COLORS.text,
      "large",
    );

    drawTextRight(
      framebuffer,
      128 - 4,
      47,
      `${stats.baselineActions}`,
      UI_COLORS.text,
      "large",
    );

    blitSprite(framebuffer, SPRITE_RESULTS_FOOTER, 0, 71);
    drawLevelHeatmap(framebuffer, stats);

    // drawText(
    //   framebuffer,
    //   stats.outcome === "win" ? 28 : 34,
    //   8,
    //   stats.outcome === "win" ? "COMPLETE" : "FAILED",
    //   UI_COLORS.text,
    //   "large",
    // );
    // drawText(
    //   framebuffer,
    //   8,
    //   24,
    //   stats.detail.toUpperCase(),
    //   UI_COLORS.textMuted,
    //   "small",
    // );

    // drawText(
    //   framebuffer,
    //   8,
    //   36,
    //   `ACTIONS ${stats.countedActions}`,
    //   UI_COLORS.text,
    //   "large",
    // );

    // if (stats.baselineActions !== null) {
    //   drawText(
    //     framebuffer,
    //     8,
    //     46,
    //     `BASELINE ${stats.baselineActions}`,
    //     UI_COLORS.text,
    //     "large",
    //   );
    // }

    // if (stats.scorePercent !== null) {
    //   drawText(
    //     framebuffer,
    //     8,
    //     56,
    //     `SCORE ${stats.scorePercent}%`,
    //     UI_COLORS.text,
    //     "large",
    //   );
    // }

    // if (stats.deltaActions !== null) {
    //   const deltaPrefix = stats.deltaActions > 0 ? "+" : "";
    //   drawText(
    //     framebuffer,
    //     8,
    //     66,
    //     `DELTA ${deltaPrefix}${stats.deltaActions}`,
    //     UI_COLORS.text,
    //     "large",
    //   );
    // }

    // drawText(
    //   framebuffer,
    //   8,
    //   74,
    //   `LEVELS ${stats.levelsCompleted}/${stats.winLevels}`,
    //   UI_COLORS.text,
    //   "small",
    // );

    // drawText(
    //   framebuffer,
    //   8,
    //   98,
    //   "SHARE STRING READY",
    //   UI_COLORS.textMuted,
    //   "small",
    // );
    // drawText(framebuffer, 8, 108, "HELP MENU", UI_COLORS.textMuted, "small");
    // drawText(framebuffer, 8, 118, "RESET RETRY", UI_COLORS.textMuted, "small");

    return {
      framebuffer,
      controls: buildWinControls(model),
      hotspots: [],
      scene: "win",
    };
  }
}
