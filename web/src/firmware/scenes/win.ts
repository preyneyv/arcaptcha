import type { ActionName } from "../../lib/api";
import { clearPersistedRunState } from "../../lib/storage";
import { drawText, drawTextCenter, drawTextRight } from "../font";
import {
  blitSprite,
  clearFramebuffer,
  createFramebuffer,
  fillRect,
  SCREEN_WIDTH,
  strokeRect,
} from "../framebuffer";
import type {
  ControlState,
  FirmwareFrame,
  FirmwareModel,
  HoverPoint,
  InteractiveRegion,
  PostGameBand,
  PostGameStats,
} from "../os";
import { findHotspot } from "../os";
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

const SHARE_BAND_GLYPHS: Record<PostGameBand, string> = {
  red: "🟥",
  yellow: "🟨",
  green: "🟩",
  blue: "🟦",
  neutral: "⬛",
};

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const COPIED_LABEL_DURATION_MS = 1200;

function formatShareDateLabel(dailyDate: string | null | undefined): string {
  if (!dailyDate) {
    return "Unknown";
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dailyDate);
  if (!match) {
    return dailyDate;
  }

  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12
  ) {
    return dailyDate;
  }

  return `${MONTH_LABELS[month - 1]} ${day}`;
}

function buildShareString(model: FirmwareModel): string | null {
  const stats = model.postGame;
  if (!stats) {
    return null;
  }

  const dailyLabel = model.daily?.gameId;
  const bandLine =
    stats.levelMetrics.length > 0
      ? stats.levelMetrics
          .map(
            (metric) =>
              SHARE_BAND_GLYPHS[metric.band] ?? SHARE_BAND_GLYPHS.neutral,
          )
          .join("")
      : SHARE_BAND_GLYPHS.neutral;

  return [
    `ARCaptcha #${dailyLabel} ⚡ ${stats.countedActions} actions`,
    bandLine,
    "⚖️ " +
      (stats.outcome === "win" ? "Generally Intelligent" : "May Be A Robot"),
    "https://arcaptcha.io",
  ].join("\n");
}

async function copyShareString(model: FirmwareModel): Promise<void> {
  const shareString = buildShareString(model);
  if (!shareString) {
    return;
  }

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return;
  }

  await navigator.clipboard.writeText(shareString);
}

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
  private static readonly SHARE_HOTSPOT_ID = "share-copy";

  private latestModel: FirmwareModel | null = null;
  private copiedLabelUntilMs = 0;
  private copiedLabelTimer: ReturnType<typeof setTimeout> | null = null;

  private showCopiedLabel(context: SceneContext): void {
    this.copiedLabelUntilMs = Date.now() + COPIED_LABEL_DURATION_MS;
    context.requestRender();

    if (this.copiedLabelTimer !== null) {
      clearTimeout(this.copiedLabelTimer);
    }

    this.copiedLabelTimer = setTimeout(() => {
      this.copiedLabelTimer = null;
      context.requestRender();
    }, COPIED_LABEL_DURATION_MS);
  }

  onEnter(): void {
    this.copiedLabelUntilMs = 0;
    if (this.copiedLabelTimer !== null) {
      clearTimeout(this.copiedLabelTimer);
      this.copiedLabelTimer = null;
    }
  }

  getSelection(): number | null {
    return null;
  }

  async dispatchAction(
    action: ActionName,
    context: SceneContext,
  ): Promise<void> {
    if (action === "ACTION5") {
      if (this.latestModel) {
        try {
          await copyShareString(this.latestModel);
        } catch {
          // Ignore clipboard write failures; gameplay flow should remain responsive.
        }

        this.showCopiedLabel(context);
      }
      return;
    }

    if (action === "RESET" && context.canDispatchGameplayAction("RESET")) {
      await context.resetSession({ revealScene: true });
      return;
    }

    if (action === "HELP") {
      context.enterHelpMenu(true);
    }
  }

  async pressScreen(
    point: HoverPoint,
    frame: FirmwareFrame,
    context: SceneContext,
  ): Promise<void> {
    const hotspot = findHotspot(frame.hotspots, point.x, point.y);
    if (!hotspot || hotspot.id !== WinSceneModule.SHARE_HOTSPOT_ID) {
      return;
    }

    await this.dispatchAction("ACTION5", context);
  }

  render(model: FirmwareModel): FirmwareFrame {
    this.latestModel = model;

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

    const hotspots: InteractiveRegion[] = [];

    if (Date.now() < this.copiedLabelUntilMs) {
      fillRect(framebuffer, 92, 121, 34, 16, UI_COLORS.background);
      drawTextRight(framebuffer, 128 - 5, 125, "COPIED", 14, "large");
    } else {
      hotspots.push({
        id: WinSceneModule.SHARE_HOTSPOT_ID,
        kind: "link",
        x: 92,
        y: 121,
        width: 34,
        height: 16,
      });
    }

    const hoveredHotspot =
      model.hoverPoint === null
        ? null
        : findHotspot(hotspots, model.hoverPoint.x, model.hoverPoint.y);
    if (hoveredHotspot) {
      strokeRect(
        framebuffer,
        hoveredHotspot.x,
        hoveredHotspot.y,
        hoveredHotspot.width,
        hoveredHotspot.height,
        UI_COLORS.warning,
      );
    }

    return {
      framebuffer,
      controls: buildWinControls(model),
      hotspots,
      scene: "win",
    };
  }
}
