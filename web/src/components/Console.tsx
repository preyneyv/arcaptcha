import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import bezel from "../assets/ui/bezel.svg";
import buttonBase from "../assets/ui/button.svg";
import buttonDiamond from "../assets/ui/button_diamond.svg";
import buttonPressed from "../assets/ui/button_pressed.svg";
import buttonTriangle from "../assets/ui/button_triangle.svg";
import clickActive from "../assets/ui/click_active.png?inline";
import clickInactive from "../assets/ui/click_inactive.png?inline";
import dpad from "../assets/ui/dpad.svg";
import dpadPress from "../assets/ui/dpad_press.svg";
import miniButton from "../assets/ui/mini_button.svg";
import miniButtonHelp from "../assets/ui/mini_button_help.svg";
import miniButtonPressed from "../assets/ui/mini_button_pressed.svg";
import miniButtonReset from "../assets/ui/mini_button_reset.svg";
import {
  framebufferToImageData,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from "../firmware/framebuffer";
import type { ControlState, HoverPoint } from "../firmware/os";
import type { ActionName } from "../lib/api";

export type ConsoleDirection = "up" | "down" | "left" | "right" | null;

export interface ConsolePressedState {
  dpadDir: ConsoleDirection;
  diamond: boolean;
  triangle: boolean;
  help: boolean;
  reset: boolean;
}

const DIR_TO_ACTION: Record<NonNullable<ConsoleDirection>, ActionName> = {
  up: "ACTION1",
  down: "ACTION2",
  left: "ACTION3",
  right: "ACTION4",
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function ConsoleScreen({
  canvasRef,
  action6Available,
  inputLocked,
  screenInteractive,
  onHoverPointChange,
  onScreenPress,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  action6Available: boolean;
  inputLocked: boolean;
  screenInteractive: boolean;
  onHoverPointChange: (point: HoverPoint | null) => boolean;
  onScreenPress: (x: number, y: number) => void;
}) {
  const [hoverInteractive, setHoverInteractive] = useState(screenInteractive);

  useEffect(() => {
    setHoverInteractive(screenInteractive);
  }, [screenInteractive]);

  const getScreenPoint = useCallback(
    (element: HTMLCanvasElement, clientX: number, clientY: number) => {
      const bounds = element.getBoundingClientRect();
      const x = Math.floor(
        ((clientX - bounds.left) / bounds.width) * SCREEN_WIDTH,
      );
      const y = Math.floor(
        ((clientY - bounds.top) / bounds.height) * SCREEN_HEIGHT,
      );

      return {
        x: clamp(x, 0, SCREEN_WIDTH - 1),
        y: clamp(y, 0, SCREEN_HEIGHT - 1),
      };
    },
    [],
  );

  const clearHoveredPoint = useCallback(() => {
    setHoverInteractive(false);
    onHoverPointChange(null);
  }, [onHoverPointChange]);

  const updateHoveredPoint = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (inputLocked) {
        clearHoveredPoint();
        return;
      }

      const screenPoint = getScreenPoint(
        event.currentTarget,
        event.clientX,
        event.clientY,
      );

      setHoverInteractive(onHoverPointChange(screenPoint));
    },
    [clearHoveredPoint, getScreenPoint, inputLocked, onHoverPointChange],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (inputLocked) {
      return;
    }

    const screenPoint = getScreenPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    onScreenPress(screenPoint.x, screenPoint.y);
  };

  return (
    <div className="console-screen">
      <canvas
        ref={canvasRef}
        className="console-screen-canvas"
        data-clickable={hoverInteractive}
        width={SCREEN_WIDTH}
        height={SCREEN_HEIGHT}
        onPointerDown={handlePointerDown}
        onPointerMove={updateHoveredPoint}
        onPointerLeave={clearHoveredPoint}
        onPointerCancel={clearHoveredPoint}
      >
        Enable JavaScript to see the console screen.
      </canvas>
      <img
        src={bezel}
        className="console-screen-bezel"
        alt=""
        draggable={false}
      />
      <img
        src={action6Available ? clickActive : clickInactive}
        className="console-screen-clickable-indicator"
        alt=""
        draggable={false}
      />
    </div>
  );
}

function ConsoleButton({
  className,
  disabled,
  icon,
  inputLocked,
  onTrigger,
  pressed,
  setPressed,
}: {
  className?: string;
  disabled?: boolean;
  icon: string;
  inputLocked: boolean;
  onTrigger: () => void;
  pressed: boolean;
  setPressed: (pressed: boolean) => void;
}) {
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (inputLocked) {
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    setPressed(true);
    onTrigger();
  };

  return (
    <button
      className={clsx("console-button", className, {
        "console-button--pressed": pressed,
      })}
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
    >
      <img
        src={pressed ? buttonPressed : buttonBase}
        className="console-button-base"
        alt=""
        draggable={false}
      />
      <img
        src={icon}
        className="console-button-icon"
        alt=""
        draggable={false}
      />
    </button>
  );
}

type Dir = "up" | "down" | "left" | "right" | null;
const dirRotation: Record<NonNullable<ConsoleDirection>, number> = {
  up: 90,
  right: 180,
  down: -90,
  left: 0,
};

function ConsoleDPad({
  activeDir,
  enabledDirections,
  inputLocked,
  onDirChange,
  onTrigger,
  disabled,
}: {
  activeDir: Dir;
  enabledDirections: Record<NonNullable<Dir>, boolean>;
  inputLocked: boolean;
  onDirChange: (dir: Dir) => void;
  onTrigger: (dir: NonNullable<Dir>) => void;
  disabled?: boolean;
}) {
  const getDir = useCallback((el: HTMLElement, px: number, py: number): Dir => {
    const rect = el.getBoundingClientRect();
    const dx = px - (rect.left + rect.width / 2);
    const dy = py - (rect.top + rect.height / 2);
    if (Math.hypot(dx, dy) < 8) return null;
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (a >= -45 && a < 45) return "right";
    if (a >= 45 && a < 135) return "down";
    if (a >= 135 || a < -135) return "left";
    return "up";
  }, []);

  const dragging = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (inputLocked) {
        return;
      }

      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      const nextDir = getDir(e.currentTarget, e.clientX, e.clientY);
      if (nextDir && enabledDirections[nextDir]) {
        onDirChange(nextDir);
        onTrigger(nextDir);
        return;
      }

      onDirChange(null);
    },
    [enabledDirections, getDir, inputLocked, onDirChange, onTrigger],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (inputLocked || !dragging.current) return;
      const nextDir = getDir(e.currentTarget, e.clientX, e.clientY);
      if (nextDir && enabledDirections[nextDir]) {
        onDirChange(nextDir);
        return;
      }

      onDirChange(null);
    },
    [enabledDirections, getDir, inputLocked, onDirChange],
  );

  const stop = useCallback(() => {
    dragging.current = false;
    onDirChange(null);
  }, [onDirChange]);

  return (
    <button
      className={clsx("console-dpad", activeDir && `active-${activeDir}`)}
      aria-label={activeDir ? `D-pad ${activeDir}` : "D-pad"}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      disabled={disabled}
    >
      <img src={dpad} className="console-dpad-base" alt="" draggable={false} />
      {activeDir && (
        <img
          src={dpadPress}
          className="console-dpad-press"
          alt=""
          aria-hidden
          draggable={false}
          style={{ transform: `rotate(${dirRotation[activeDir]}deg)` }}
        />
      )}
    </button>
  );
}

function ConsoleMiniButton({
  className,
  disabled,
  inputLocked,
  label,
  onTrigger,
  pressed,
  setPressed,
}: {
  className?: string;
  disabled?: boolean;
  inputLocked: boolean;
  label: string;
  onTrigger: () => void;
  pressed: boolean;
  setPressed: (pressed: boolean) => void;
}) {
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (inputLocked) {
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    setPressed(true);
    onTrigger();
  };

  return (
    <div className="console-mini-button-container">
      <button
        className={clsx("console-mini-button", className, {
          "console-mini-button--pressed": pressed,
        })}
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerUp={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
      >
        <img
          src={pressed ? miniButtonPressed : miniButton}
          className="console-mini-button-base"
          alt=""
          draggable={false}
        />
      </button>
      <img
        src={label}
        className="console-mini-button-label"
        alt=""
        draggable={false}
      />
    </div>
  );
}

export function Console({
  framebuffer,
  controls,
  inputLocked,
  pressedState,
  screenInteractive,
  onAction,
  onHoverPointChange,
  onScreenPress,
}: {
  framebuffer: Uint8Array;
  controls: ControlState;
  inputLocked: boolean;
  pressedState: ConsolePressedState;
  screenInteractive: boolean;
  onAction: (action: ActionName) => void;
  onHoverPointChange: (point: HoverPoint | null) => boolean;
  onScreenPress: (x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [diamondPressed, setDiamondPressed] = useState(false);
  const [trianglePressed, setTrianglePressed] = useState(false);
  const [helpPressed, setHelpPressed] = useState(false);
  const [resetPressed, setResetPressed] = useState(false);
  const [dpadDir, setDpadDir] = useState<Dir>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.putImageData(framebufferToImageData(framebuffer), 0, 0);
  }, [framebuffer]);

  const enabledDirections = {
    up: controls.ACTION1,
    down: controls.ACTION2,
    left: controls.ACTION3,
    right: controls.ACTION4,
  } satisfies Record<NonNullable<Dir>, boolean>;

  const dpadDisabled = !Object.values(enabledDirections).some(Boolean);
  const activeDpadDir = dpadDir ?? pressedState.dpadDir;
  const triangleIsPressed = trianglePressed || pressedState.triangle;
  const diamondIsPressed = diamondPressed || pressedState.diamond;
  const helpIsPressed = helpPressed || pressedState.help;
  const resetIsPressed = resetPressed || pressedState.reset;

  return (
    <div className="console-chin">
      <main className="console">
        <div className="console-content">
          <ConsoleScreen
            canvasRef={canvasRef}
            action6Available={controls.ACTION6}
            inputLocked={inputLocked}
            screenInteractive={screenInteractive}
            onHoverPointChange={onHoverPointChange}
            onScreenPress={onScreenPress}
          />
          <div className="console-ui">
            <div className="console-action-row-1">
              <ConsoleDPad
                activeDir={activeDpadDir}
                enabledDirections={enabledDirections}
                inputLocked={inputLocked}
                onDirChange={setDpadDir}
                onTrigger={(dir) => onAction(DIR_TO_ACTION[dir])}
                disabled={dpadDisabled}
              />
              <div className="console-buttons">
                <ConsoleButton
                  icon={buttonTriangle}
                  disabled={!controls.ACTION7}
                  inputLocked={inputLocked}
                  onTrigger={() => onAction("ACTION7")}
                  pressed={triangleIsPressed}
                  setPressed={setTrianglePressed}
                />
                <ConsoleButton
                  icon={buttonDiamond}
                  disabled={!controls.ACTION5}
                  inputLocked={inputLocked}
                  onTrigger={() => onAction("ACTION5")}
                  pressed={diamondIsPressed}
                  setPressed={setDiamondPressed}
                />
              </div>
            </div>
            <div className="console-action-row-2">
              <ConsoleMiniButton
                disabled={!controls.HELP}
                inputLocked={inputLocked}
                label={miniButtonHelp}
                onTrigger={() => onAction("HELP")}
                pressed={helpIsPressed}
                setPressed={setHelpPressed}
              />
              <ConsoleMiniButton
                disabled={!controls.RESET}
                inputLocked={inputLocked}
                label={miniButtonReset}
                onTrigger={() => onAction("RESET")}
                pressed={resetIsPressed}
                setPressed={setResetPressed}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
