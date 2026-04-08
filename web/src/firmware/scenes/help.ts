import type { ActionName } from "../../lib/api";
import { drawText, drawTextCenter, drawTextRight } from "../font";
import {
  blitSprite,
  clearFramebuffer,
  createFramebuffer,
} from "../framebuffer";
import {
  findHotspot,
  getNextHelpSelection,
  type ControlState,
  type FirmwareFrame,
  type FirmwareModel,
  type HelpLink,
  type InteractiveRegion,
  type MenuActionId,
} from "../os";
import { UI_COLORS } from "../palette";
import type { Sprite } from "../sprites";
import {
  SPIRTE_PLAY,
  SPRITE_CONTROLS_CIRCLE,
  SPRITE_CONTROLS_DIAMOND,
  SPRITE_CONTROLS_DISABLED,
  SPRITE_CONTROLS_DPAD_DOWN,
  SPRITE_CONTROLS_DPAD_LEFT,
  SPRITE_CONTROLS_DPAD_RIGHT,
  SPRITE_CONTROLS_DPAD_UP,
  SPRITE_CONTROLS_TOUCH,
  SPRITE_LOGO,
  SPRITE_RESULT,
  SPRITE_RESUME,
} from "../sprites";
import type { SceneContext, SceneModule } from "./base";

const MENU_ITEMS: readonly HelpLink[] = [
  { id: "primary", label: "PRIMARY" },
  { id: "about", label: "ABOUT" },
];

type HelpPrimaryVariant = "play" | "resume" | "results";

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

function getSelectionForAction(action: MenuActionId): number | null {
  if (action === "play") {
    return 0;
  }

  if (action === "about") {
    return 1;
  }

  return null;
}

export class HelpSceneModule implements SceneModule {
  private selection: number | null = 0;
  private primaryVariant: HelpPrimaryVariant = "play";

  onEnter(): void {
    this.selection = 0;
    this.primaryVariant = "play";
  }

  getSelection(): number | null {
    return this.selection;
  }

  private syncPrimaryAction(model: FirmwareModel): void {
    if (model.postGame) {
      this.primaryVariant = "results";
      return;
    }

    if (model.session && model.session.countedActions > 1) {
      this.primaryVariant = "resume";
      return;
    }

    this.primaryVariant = "play";
  }

  private getMenuAction(selection: number | null): MenuActionId {
    return selection === 1 ? "about" : "play";
  }

  private async transitionForMenuAction(
    action: MenuActionId,
    context: SceneContext,
  ): Promise<void> {
    if (action === "about") {
      await context.requestSceneTransition("about", { clearError: true });
      return;
    }

    if (this.primaryVariant === "results") {
      await context.requestSceneTransition("win", { clearError: true });
      return;
    }

    await context.requestSceneTransition("play", { clearError: true });
  }

  private getPrimarySprite(): Sprite {
    switch (this.primaryVariant) {
      case "resume":
        return SPRITE_RESUME;
      case "results":
        return SPRITE_RESULT;
      case "play":
      default:
        return SPIRTE_PLAY;
    }
  }

  async dispatchAction(
    action: ActionName,
    context: SceneContext,
  ): Promise<void> {
    const canQueueSessionReveal =
      context.isInputLocked() && context.hasPendingSessionStart();

    if (
      context.isInputLocked() &&
      !canQueueSessionReveal &&
      action !== "ACTION1" &&
      action !== "ACTION2" &&
      action !== "ACTION3" &&
      action !== "ACTION4"
    ) {
      return;
    }

    if (action === "HELP") {
      return;
    }

    if (action === "RESET") {
      await context.resetSession({ revealScene: true });
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
      return;
    }

    if (action === "ACTION5") {
      await this.transitionForMenuAction(
        this.getMenuAction(this.selection),
        context,
      );
    }
  }

  async pressScreen(
    point: { x: number; y: number },
    frame: FirmwareFrame,
    context: SceneContext,
  ): Promise<void> {
    if (context.isInputLocked() && !context.hasPendingSessionStart()) {
      return;
    }

    const hotspot = findHotspot(frame.hotspots, point.x, point.y);
    if (hotspot?.kind === "action") {
      await this.transitionForMenuAction(hotspot.action, context);
    }
  }

  render(model: FirmwareModel): FirmwareFrame {
    const framebuffer = createFramebuffer(UI_COLORS.background);
    const controls = createControlState(true);
    const hotspots: InteractiveRegion[] = [];

    clearFramebuffer(framebuffer, UI_COLORS.background);
    blitSprite(framebuffer, SPRITE_LOGO);

    this.syncPrimaryAction(model);
    const primarySprite = this.getPrimarySprite();
    const primaryButtonX = Math.floor((128 - primarySprite.width) / 2);
    const primaryHotspotId = this.primaryVariant;

    if (!(model.daily && model.session)) {
      drawText(framebuffer, 44, 125, "LOADING", UI_COLORS.textMuted, "large");
      return {
        framebuffer,
        controls,
        hotspots,
        scene: "help",
      };
    }

    drawText(
      framebuffer,
      14,
      35,
      `${model.daily.gameId.split("-")[0].toUpperCase()}`,
      UI_COLORS.text,
      "large",
    );
    drawTextRight(
      framebuffer,
      128 - 14,
      35,
      `${model.daily.date}`,
      UI_COLORS.textMuted,
      "large",
    );

    drawTextCenter(framebuffer, 64, 50, "AVAILABLE CONTROLS", 4, "small");

    blitSprite(framebuffer, SPRITE_CONTROLS_DISABLED, 16, 57);
    const allowed = model.session.availableActions;
    for (const enabledAction of allowed) {
      switch (enabledAction) {
        case "ACTION1":
          blitSprite(framebuffer, SPRITE_CONTROLS_DPAD_UP, 29, 63, { [4]: 1 });
          break;
        case "ACTION2":
          blitSprite(framebuffer, SPRITE_CONTROLS_DPAD_DOWN, 29, 80, {
            [4]: 1,
          });
          break;
        case "ACTION3":
          blitSprite(framebuffer, SPRITE_CONTROLS_DPAD_LEFT, 21, 71, {
            [4]: 1,
          });
          break;
        case "ACTION4":
          blitSprite(framebuffer, SPRITE_CONTROLS_DPAD_RIGHT, 38, 71, {
            [4]: 1,
          });
          break;
        case "ACTION5":
          blitSprite(framebuffer, SPRITE_CONTROLS_DIAMOND, 92, 61, {
            [4]: 1,
          });
          break;
        case "ACTION6":
          blitSprite(framebuffer, SPRITE_CONTROLS_TOUCH, 57, 67, { [4]: 1 });
          break;
        case "ACTION7":
          blitSprite(framebuffer, SPRITE_CONTROLS_CIRCLE, 80, 74, { [4]: 1 });
          break;
        case "HELP":
        case "RESET":
          break;
      }
    }

    hotspots.push({
      id: primaryHotspotId,
      kind: "action",
      action: "play",
      x: primaryButtonX - 2,
      y: 98,
      width: primarySprite.width + 4,
      height: primarySprite.height + 4,
    });

    hotspots.push({
      id: "about",
      kind: "action",
      action: "about",
      x: 48,
      y: 123,
      width: 33,
      height: 11,
    });

    const hoveredHotspot =
      model.hoverPoint === null
        ? null
        : findHotspot(hotspots, model.hoverPoint.x, model.hoverPoint.y);

    if (hoveredHotspot?.kind === "action") {
      const hoveredSelection = getSelectionForAction(hoveredHotspot.action);
      if (hoveredSelection !== null) {
        this.selection = hoveredSelection;
      }
    }

    const selectedAction = this.getMenuAction(this.selection);
    const indicatorHotspot = hotspots.find(
      (hotspot) =>
        hotspot.kind === "action" && hotspot.action === selectedAction,
    );

    blitSprite(framebuffer, primarySprite, primaryButtonX, 100, {
      [12]: indicatorHotspot?.id === primaryHotspotId ? 14 : 4,
    });
    drawText(
      framebuffer,
      50,
      125,
      "ABOUT",
      indicatorHotspot?.id === "about" ? 14 : 4,
      "large",
    );

    return {
      framebuffer,
      controls,
      hotspots,
      scene: "help",
    };
  }
}
