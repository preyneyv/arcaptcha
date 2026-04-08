import type { ActionName } from "../../lib/api";
import type { Framebuffer } from "../framebuffer";
import type {
  FirmwareFrame,
  FirmwareModel,
  HoverPoint,
  MenuActionId,
} from "../os";

export type GameplayActionName = Exclude<ActionName, "HELP">;

export interface SceneContext {
  isInputLocked(): boolean;
  hasPendingSessionStart(): boolean;
  hasSession(): boolean;
  canDispatchGameplayAction(action: ActionName): boolean;
  resetSession(options?: { revealScene?: boolean }): Promise<void>;
  activateMenuAction(action: MenuActionId): Promise<void>;
  runGameplayAction(
    action: GameplayActionName,
    extraData?: Record<string, unknown>,
  ): Promise<void>;
  pulseClickCursor(point: HoverPoint): void;
  enterHelpMenu(clearError?: boolean): void;
  requestRender(): void;
}

export interface SceneModule {
  onEnter(): void;
  getSelection(): number | null;
  dispatchAction(action: ActionName, context: SceneContext): Promise<void>;
  pressScreen(
    point: HoverPoint,
    frame: FirmwareFrame,
    context: SceneContext,
  ): Promise<void>;
  render(model: FirmwareModel): FirmwareFrame;
  beginLocalAnimation?(from: Framebuffer): void;
  hasActiveLocalAnimation?(): boolean;
  clearLocalAnimation?(): void;
}
