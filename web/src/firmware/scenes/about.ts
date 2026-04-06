import type { ActionName } from "../../lib/api";
import { drawText } from "../font";
import {
  clearFramebuffer,
  createFramebuffer,
  strokeRect,
} from "../framebuffer";
import {
  findHotspot,
  getNextHelpSelection,
  type ControlState,
  type FirmwareFrame,
  type FirmwareModel,
  type HelpLink,
  type InteractiveRegion,
} from "../os";
import { UI_COLORS } from "../palette";
import type { SceneContext, SceneModule } from "./base";

const MENU_ITEMS: readonly HelpLink[] = [{ id: "back", label: "BACK" }];

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

export class AboutSceneModule implements SceneModule {
  private selection: number | null = 0;

  onEnter(): void {
    this.selection = 0;
  }

  getSelection(): number | null {
    return this.selection;
  }

  async dispatchAction(
    action: ActionName,
    context: SceneContext,
  ): Promise<void> {
    if (action === "RESET" || action === "ACTION5") {
      await context.activateMenuAction("back");
      return;
    }

    if (action === "ACTION1" || action === "ACTION3") {
      this.selection =
        getNextHelpSelection(this.selection, -1, MENU_ITEMS) ?? 0;
      context.requestRender();
      return;
    }

    if (action === "ACTION2" || action === "ACTION4") {
      this.selection = getNextHelpSelection(this.selection, 1, MENU_ITEMS) ?? 0;
      context.requestRender();
    }
  }

  async pressScreen(
    point: { x: number; y: number },
    frame: FirmwareFrame,
    context: SceneContext,
  ): Promise<void> {
    if (context.isInputLocked()) {
      return;
    }

    const hotspot = findHotspot(frame.hotspots, point.x, point.y);
    if (hotspot?.kind === "action") {
      await context.activateMenuAction(hotspot.action);
    }
  }

  render(model: FirmwareModel): FirmwareFrame {
    const framebuffer = createFramebuffer(UI_COLORS.background);
    const controls = createControlState(true);
    const hotspots: InteractiveRegion[] = [
      {
        id: "back",
        kind: "action",
        action: "back",
        x: 42,
        y: 119,
        width: 44,
        height: 13,
      },
    ];

    clearFramebuffer(framebuffer, UI_COLORS.background);
    strokeRect(framebuffer, 0, 0, 128, 140, UI_COLORS.border);
    drawText(framebuffer, 44, 8, "ABOUT", UI_COLORS.text, "large");
    drawText(framebuffer, 18, 52, "BLANK SCREEN", UI_COLORS.textMuted, "large");
    drawText(framebuffer, 43, 121, "BACK", UI_COLORS.text, "large");

    const selectedHotspot =
      hotspots[this.selection ?? 0] ?? hotspots[0] ?? null;
    if (selectedHotspot) {
      strokeRect(
        framebuffer,
        selectedHotspot.x,
        selectedHotspot.y,
        selectedHotspot.width,
        selectedHotspot.height,
        UI_COLORS.selection,
      );
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
      controls,
      hotspots,
      scene: "about",
    };
  }
}
