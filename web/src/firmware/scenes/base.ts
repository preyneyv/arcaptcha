import type { ActionName } from "../../lib/api";
import type {
  FirmwareFrame,
  FirmwareModel,
  HoverPoint,
  SceneKind,
} from "../os";

export type GameplayActionName = Exclude<ActionName, "HELP">;

export type SceneTransitionDeferMode =
  | "now"
  | "after-playback"
  | "after-render";

export interface GameplayActionResult {
  nextScene: SceneKind;
  transitionDefer: SceneTransitionDeferMode;
}

export interface SceneTransitionRequest {
  clearError?: boolean;
  defer?: SceneTransitionDeferMode;
}

export interface SceneContext {
  isInputLocked(): boolean;
  hasPendingSessionStart(): boolean;
  hasSession(): boolean;
  canDispatchGameplayAction(action: ActionName): boolean;
  resetSession(options?: { revealScene?: boolean }): Promise<void>;
  requestSceneTransition(
    scene: SceneKind,
    request?: SceneTransitionRequest,
  ): Promise<void>;
  runGameplayAction(
    action: GameplayActionName,
    extraData?: Record<string, unknown>,
  ): Promise<GameplayActionResult | null>;
  pulseClickCursor(point: HoverPoint): void;
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
}
