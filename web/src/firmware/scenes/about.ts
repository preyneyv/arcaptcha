import type { ActionName } from "../../lib/api";
import { isIosOrAndroidPlatform } from "../Firmware";
import { drawTextCenter } from "../font";
import { blitSprite, createFramebuffer, strokeRect } from "../framebuffer";
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
import { SPRITE_ABOUT } from "../sprites";
import type { SceneContext, SceneModule } from "./base";

const MENU_ITEMS: readonly HelpLink[] = [{ id: "back", label: "BACK" }];

const GITHUB_URL = "https://github.com/preyneyv/arcaptcha";
const ARC_AGI_URL = "https://arcprize.org/arc-agi/3";
const LICENSES_URL = "/THIRD_PARTY_LICENSES.txt";

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
      await context.requestSceneTransition("help", { clearError: true });
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
      await context.requestSceneTransition("help", { clearError: true });
    } else if (hotspot?.kind === "link" && hotspot.href) {
      if (isIosOrAndroidPlatform()) {
        window.location.href = hotspot.href;
      } else {
        window.open(hotspot.href, "_blank", "noopener");
      }
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
        x: 51,
        y: 123,
        width: 27,
        height: 11,
      },
      {
        id: "arc-agi-3",
        kind: "link",
        href: ARC_AGI_URL,
        x: 47,
        y: 28,
        width: 43,
        height: 10,
      },
      {
        id: "github",
        kind: "link",
        href: GITHUB_URL,
        x: 12,
        y: 98,
        width: 28,
        height: 10,
      },
      {
        id: "licenses",
        kind: "link",
        href: LICENSES_URL,
        x: 78,
        y: 98,
        width: 38,
        height: 10,
      },
    ];

    blitSprite(framebuffer, SPRITE_ABOUT);
    drawTextCenter(framebuffer, 64, 125, "BACK", 14, "large");

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
