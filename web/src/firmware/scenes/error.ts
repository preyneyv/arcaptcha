import type { ActionName } from "../../lib/api";
import { drawText, getLineHeight, wrapText } from "../font";
import {
  clearFramebuffer,
  createFramebuffer,
  fillRect,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  strokeRect,
} from "../framebuffer";
import type {
  ControlState,
  FirmwareFrame,
  FirmwareModel,
  HoverPoint,
} from "../os";
import { UI_COLORS } from "../palette";
import type { SceneContext, SceneModule } from "./base";

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

function buildErrorControls(model: FirmwareModel): ControlState {
  const controls = createControlState(false);
  controls.HELP = true;
  controls.RESET = Boolean(model.daily);
  return controls;
}

export class ErrorSceneModule implements SceneModule {
  onEnter(): void {}

  getSelection(): number | null {
    return null;
  }

  async dispatchAction(
    action: ActionName,
    context: SceneContext,
  ): Promise<void> {
    if (action === "RESET") {
      await context.resetSession({ revealScene: true });
      return;
    }

    await context.requestSceneTransition("help", { clearError: true });
  }

  async pressScreen(
    _point: HoverPoint,
    _frame: FirmwareFrame,
    _context: SceneContext,
  ): Promise<void> {}

  render(model: FirmwareModel): FirmwareFrame {
    const framebuffer = createFramebuffer(UI_COLORS.background);
    const controls = buildErrorControls(model);
    const lines = wrapText(
      model.error ?? "ERROR",
      SCREEN_WIDTH - 12,
      "large",
    ).slice(0, 6);

    clearFramebuffer(framebuffer, UI_COLORS.background);
    strokeRect(
      framebuffer,
      0,
      0,
      SCREEN_WIDTH,
      SCREEN_HEIGHT,
      UI_COLORS.border,
    );
    fillRect(framebuffer, 0, 0, SCREEN_WIDTH, 10, UI_COLORS.selection);
    drawText(framebuffer, 4, 1, "ERROR", UI_COLORS.textInverse, "large");

    lines.forEach((line, index) => {
      drawText(
        framebuffer,
        6,
        16 + index * getLineHeight("large"),
        line,
        UI_COLORS.text,
        "large",
      );
    });

    drawText(
      framebuffer,
      6,
      120,
      "TRY REFRESHING",
      UI_COLORS.textMuted,
      "large",
    );

    return {
      framebuffer,
      controls,
      hotspots: [],
      scene: "error",
    };
  }
}
