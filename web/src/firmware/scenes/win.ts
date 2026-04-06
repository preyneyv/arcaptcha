import type { ActionName } from "../../lib/api";
import { drawText } from "../font";
import { clearFramebuffer, createFramebuffer } from "../framebuffer";
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

function buildWinControls(model: FirmwareModel): ControlState {
  const controls = createControlState(false);
  controls.HELP = true;
  controls.RESET = Boolean(model.daily);
  return controls;
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
    if (action === "RESET") {
      await context.resetSession({ revealScene: true });
    }
  }

  async pressScreen(
    _point: HoverPoint,
    _frame: FirmwareFrame,
    _context: SceneContext,
  ): Promise<void> {}

  render(model: FirmwareModel): FirmwareFrame {
    const framebuffer = createFramebuffer(UI_COLORS.background);
    clearFramebuffer(framebuffer, UI_COLORS.background);
    drawText(framebuffer, 34, 58, "COMPLETE", UI_COLORS.text, "large");

    return {
      framebuffer,
      controls: buildWinControls(model),
      hotspots: [],
      scene: "win",
    };
  }
}
