import clsx from "clsx";
import { useCallback, useRef, useState } from "react";
import buttonBase from "../assets/ui/button.svg";
import buttonDiamond from "../assets/ui/button_diamond.svg";
import buttonPressed from "../assets/ui/button_pressed.svg";
import buttonTriangle from "../assets/ui/button_triangle.svg";
import dpad from "../assets/ui/dpad.svg";
import dpadPress from "../assets/ui/dpad_press.svg";
import miniButton from "../assets/ui/mini_button.svg";
import miniButtonHelp from "../assets/ui/mini_button_help.svg";
import miniButtonPressed from "../assets/ui/mini_button_pressed.svg";
import miniButtonReset from "../assets/ui/mini_button_reset.svg";
import type { ActionName } from "../lib/api";

const DIRECTION_CONTROLS: Array<{
  action: Extract<ActionName, "ACTION1" | "ACTION2" | "ACTION3" | "ACTION4">;
  className: string;
  label: string;
}> = [
  { action: "ACTION1", className: "up", label: "UP" },
  { action: "ACTION2", className: "down", label: "DN" },
  { action: "ACTION3", className: "left", label: "LT" },
  { action: "ACTION4", className: "right", label: "RT" },
];

type ButtonState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  use: boolean;
  aim: boolean;
  undo: boolean;
  reset: boolean;
};

function ConsoleScreen({ ref }: { ref?: React.Ref<HTMLCanvasElement> }) {
  return (
    <div className="console-screen">
      <canvas
        ref={ref}
        className="console-screen-canvas"
        width={100}
        height={100}
      >
        Enable JavaScript to see the console screen.
      </canvas>
      <svg
        width="128"
        height="141"
        viewBox="0 0 128 141"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M6.66699 1.5H121.333C124.186 1.5 126.5 3.81355 126.5 6.66699V130.965C126.5 133.231 125.046 135.081 122.957 135.486C115.287 136.973 97.3401 139.5 64 139.5C30.6599 139.5 12.7134 136.973 5.04297 135.486C2.95359 135.081 1.50019 133.231 1.5 130.965V6.66699C1.5 3.81355 3.81355 1.5 6.66699 1.5Z"
          fill="#0B0B0B"
          stroke="url(#paint0_linear_28_236)"
          strokeWidth="3"
        />
        <rect x="14" y="14" width="100" height="100" fill="#D9D9D9" />
        <path
          d="M14 113C14 113.518 14.3933 113.944 14.8975 113.995L15 114H113C113.552 114 114 113.552 114 113V15C114 14.4477 113.552 14 113 14V12C114.657 12 116 13.3431 116 15V113C116 114.657 114.657 116 113 116H15C13.3431 116 12 114.657 12 113V15C12 13.3431 13.3431 12 15 12V14L14.8975 14.0049C14.3933 14.0562 14 14.4823 14 15V113ZM113 12V14H15V12H113Z"
          fill="#303030"
        />
        <path
          d="M94.2493 128.315C94.4477 128.315 94.6063 128.157 94.6063 127.958V127.783C94.6063 127.59 94.4477 127.431 94.2493 127.431H91.416C91.2233 127.431 91.0647 127.59 91.0647 127.783V127.958C91.0647 128.157 91.2233 128.315 91.416 128.315H94.2493ZM90.7077 129.732C89.9257 129.732 89.291 129.097 89.291 128.315V127.607C89.291 126.825 89.9257 126.19 90.7077 126.19H94.2493C94.4477 126.19 94.6063 126.032 94.6063 125.833C94.6063 125.641 94.4477 125.482 94.2493 125.482H89.648V124.065H94.9577C95.7397 124.065 96.3743 124.7 96.3743 125.482V128.315C96.3743 129.097 95.7397 129.732 94.9577 129.732H90.7077Z"
          fill="#303030"
        />
        <path
          d="M81.6348 129.732V123H83.4084V123.708C83.4084 123.907 83.5671 124.065 83.7598 124.065H87.3014C88.0834 124.065 88.7181 124.7 88.7181 125.482V129.732H86.9501V126.19C86.9501 125.799 86.6328 125.482 86.2418 125.482H84.1168C83.7258 125.482 83.4084 125.799 83.4084 126.19V129.732H81.6348Z"
          fill="#303030"
        />
        <path
          d="M76.1037 129.732C75.3217 129.732 74.687 129.097 74.687 128.315V125.482C74.687 124.7 75.3217 124.065 76.1037 124.065H81.062V125.482H77.169C76.778 125.482 76.4607 125.799 76.4607 126.19V127.607C76.4607 127.998 76.778 128.315 77.169 128.315H81.062V129.732H76.1037Z"
          fill="#303030"
        />
        <path
          d="M71.9894 129.732C71.2074 129.732 70.5728 129.097 70.5728 128.315V123H72.3464V123.708C72.3464 123.907 72.5051 124.065 72.6978 124.065H73.9388V125.482H72.6978C72.5051 125.482 72.3464 125.641 72.3464 125.833V127.607C72.3464 127.998 72.6638 128.315 73.0548 128.315H74.1144V129.732H71.9894Z"
          fill="#303030"
        />
        <path
          d="M67.5235 128.315C67.9145 128.315 68.2318 127.998 68.2318 127.607V126.19C68.2318 125.799 67.9145 125.482 67.5235 125.482H65.3985C65.0075 125.482 64.6902 125.799 64.6902 126.19V127.958C64.6902 128.157 64.8488 128.315 65.0415 128.315H67.5235ZM62.9165 130.792V125.482C62.9165 124.7 63.5512 124.065 64.3332 124.065H68.5832C69.3652 124.065 69.9998 124.7 69.9998 125.482V128.315C69.9998 129.097 69.3652 129.732 68.5832 129.732H65.0415C64.8488 129.732 64.6902 129.891 64.6902 130.083V130.792H62.9165Z"
          fill="#303030"
        />
        <path
          d="M60.2186 128.315C60.4169 128.315 60.5756 128.157 60.5756 127.958V127.783C60.5756 127.59 60.4169 127.431 60.2186 127.431H57.3853C57.1926 127.431 57.0339 127.59 57.0339 127.783V127.958C57.0339 128.157 57.1926 128.315 57.3853 128.315H60.2186ZM56.6769 129.732C55.8949 129.732 55.2603 129.097 55.2603 128.315V127.607C55.2603 126.825 55.8949 126.19 56.6769 126.19H60.2186C60.4169 126.19 60.5756 126.032 60.5756 125.833C60.5756 125.641 60.4169 125.482 60.2186 125.482H55.6173V124.065H60.9269C61.7089 124.065 62.3436 124.7 62.3436 125.482V128.315C62.3436 129.097 61.7089 129.732 60.9269 129.732H56.6769Z"
          fill="#303030"
        />
        <path
          d="M49.7292 129.732C48.9472 129.732 48.3125 129.097 48.3125 128.315V125.482C48.3125 124.7 48.9472 124.065 49.7292 124.065H54.6875V125.482H50.7945C50.4035 125.482 50.0862 125.799 50.0862 126.19V127.607C50.0862 127.998 50.4035 128.315 50.7945 128.315H54.6875V129.732H49.7292Z"
          fill="#989898"
        />
        <path
          d="M45.2632 126.723C45.6202 126.723 45.9206 126.451 45.9659 126.1C45.9206 125.754 45.6202 125.482 45.2632 125.482H42.7813C42.5886 125.482 42.4299 125.641 42.4299 125.833V126.366C42.4299 126.564 42.5886 126.723 42.7813 126.723H45.2632ZM40.6562 129.732V124.065H46.3229C47.1049 124.065 47.7396 124.7 47.7396 125.482V126.542C47.7396 126.967 47.5526 127.346 47.2579 127.607C47.5526 127.868 47.7396 128.247 47.7396 128.667V129.732H45.9716V128.491C45.9716 128.298 45.8129 128.14 45.6146 128.14H42.7813C42.5886 128.14 42.4299 128.298 42.4299 128.491V129.732H40.6562Z"
          fill="#989898"
        />
        <path
          d="M37.9583 126.723C38.1567 126.723 38.3153 126.564 38.3153 126.366V126.19C38.3153 125.799 37.998 125.482 37.607 125.482H35.482C35.091 125.482 34.7737 125.799 34.7737 126.19V126.366C34.7737 126.564 34.9323 126.723 35.125 126.723H37.9583ZM33 129.732V125.482C33 124.7 33.6347 124.065 34.4167 124.065H38.6667C39.4487 124.065 40.0833 124.7 40.0833 125.482V129.732H38.3153V128.491C38.3153 128.298 38.1567 128.14 37.9583 128.14H35.125C34.9323 128.14 34.7737 128.298 34.7737 128.491V129.732H33Z"
          fill="#989898"
        />
        <defs>
          <linearGradient
            id="paint0_linear_28_236"
            x1="70.2356"
            y1="0"
            x2="70.2356"
            y2="141"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0.0484643" stopColor="#844D00" />
            <stop offset="0.0980919" stopColor="#955700" />
            <stop offset="0.788367" stopColor="#A25E00" />
            <stop offset="0.958303" stopColor="#B86B00" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

function ConsoleButton({
  className,
  disabled,
  icon,
  pressed,
  setPressed,
}: {
  className?: string;
  disabled?: boolean;
  icon: string;
  pressed: boolean;
  setPressed: (pressed: boolean) => void;
}) {
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPressed(true);
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
const dirRotation: Record<NonNullable<Dir>, number> = {
  up: 90,
  right: 180,
  down: -90,
  left: 0,
};

function ConsoleDPad({
  activeDir,
  onDirChange,
  disabled,
}: {
  activeDir: Dir;
  onDirChange: (dir: Dir) => void;
  disabled?: boolean;
}) {
  const getDir = useCallback((el: HTMLElement, px: number, py: number): Dir => {
    const rect = el.getBoundingClientRect();
    const dx = px - (rect.left + rect.width / 2);
    const dy = py - (rect.top + rect.height / 2);
    if (Math.hypot(dx, dy) < 0) return null;
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (a >= -45 && a < 45) return "right";
    if (a >= 45 && a < 135) return "down";
    if (a >= 135 || a < -135) return "left";
    return "up";
  }, []);

  const dragging = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragging.current = true;
      onDirChange(getDir(e.currentTarget, e.clientX, e.clientY));
    },
    [getDir, onDirChange],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (!dragging.current) return;
      onDirChange(getDir(e.currentTarget, e.clientX, e.clientY));
    },
    [getDir, onDirChange],
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
  label,
  pressed,
  setPressed,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  pressed: boolean;
  setPressed: (pressed: boolean) => void;
}) {
  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPressed(true);
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

export function Console() {
  // const availableSet = new Set(availableActions);
  // const resetEnabled = availableSet.has("RESET");
  // const undoEnabled = availableSet.has("ACTION7");
  // const useEnabled = availableSet.has("ACTION5");
  // const aimEnabled = availableSet.has("ACTION6");
  const [diaPressed, setDiaPressed] = useState(false);
  const [dpadDir, setDpadDir] = useState<Dir>(null);

  return (
    <div className="console-chin">
      <main className="console">
        <div className="console-content">
          <ConsoleScreen />
          <div className="console-ui">
            <div className="console-action-row-1">
              <ConsoleDPad activeDir={dpadDir} onDirChange={setDpadDir} />
              <div className="console-buttons">
                <ConsoleButton
                  icon={buttonTriangle}
                  pressed={false}
                  setPressed={() => {}}
                />
                <ConsoleButton
                  icon={buttonDiamond}
                  pressed={diaPressed}
                  setPressed={setDiaPressed}
                />
              </div>
            </div>
            <div className="console-action-row-2">
              <ConsoleMiniButton
                label={miniButtonHelp}
                pressed={false}
                setPressed={() => {}}
              />
              <ConsoleMiniButton
                label={miniButtonReset}
                pressed={false}
                setPressed={() => {}}
              />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
