import type { ActionName } from "../../lib/api";
import { clearPersistedRunState } from "../../lib/storage";
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

function parseDailyDateToUtcMs(
  dailyDate: string | null | undefined,
): number | null {
  if (!dailyDate) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dailyDate);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return null;
  }

  return Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0);
}

function formatCountdownMs(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = Math.floor(totalSeconds / 3600)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function getResetCountdownLabel(dailyDate: string | null | undefined): string {
  const nextResetUtcMs = parseDailyDateToUtcMs(dailyDate);
  if (nextResetUtcMs === null) {
    return "--:--:--";
  }

  return formatCountdownMs(nextResetUtcMs - Date.now());
}

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
  controls.ACTION6 = true;
  controls.ACTION5 = true;

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
  const y = 79;

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
      clearPersistedRunState();
      window.location.reload();
      return {
        framebuffer,
        controls: buildWinControls(model),
        hotspots: [],
        scene: "win",
      };
      drawText(framebuffer, 22, 58, "POST GAME", UI_COLORS.text, "large");
      drawText(framebuffer, 28, 72, "NO DATA", UI_COLORS.textMuted, "large");
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
      48,
      `${stats.scorePercent}`,
      UI_COLORS.text,
      "large",
    );

    drawTextCenter(
      framebuffer,
      64,
      48,
      `${stats.countedActions}`,
      UI_COLORS.text,
      "large",
    );

    drawTextRight(
      framebuffer,
      128 - 4,
      48,
      `${stats.baselineActions}`,
      UI_COLORS.text,
      "large",
    );

    blitSprite(framebuffer, SPRITE_RESULTS_FOOTER, 0, 69);
    drawLevelHeatmap(framebuffer, stats);

    drawTextRight(
      framebuffer,
      128 - 4,
      109,
      getResetCountdownLabel(model.daily?.date),
      UI_COLORS.text,
      "large",
    );

    return {
      framebuffer,
      controls: buildWinControls(model),
      hotspots: [],
      scene: "win",
    };
  }
}
