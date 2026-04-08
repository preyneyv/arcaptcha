import {
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { Console, type ConsolePressedState } from "./components/Console";
import { ConwayBackground } from "./components/ConwayBackground";
import {
  Firmware,
  type FirmwareApi,
  type FirmwareSnapshot,
  type ShareTransferMode,
} from "./firmware/Firmware";
import { WinSceneModule } from "./firmware/scenes";
import {
  bootstrapDailySession,
  keepAliveUnloadDailySession,
  sendAction,
  unloadDailySession,
  type ActionName,
} from "./lib/api";
import { getOrCreatePlayerId } from "./lib/storage";

const FIRMWARE_API: FirmwareApi = {
  bootstrapDailySession,
  sendAction,
  unloadDailySession,
};

const KEY_TO_ACTION: Record<string, ActionName> = {
  w: "ACTION1",
  ArrowUp: "ACTION1",
  s: "ACTION2",
  ArrowDown: "ACTION2",
  a: "ACTION3",
  ArrowLeft: "ACTION3",
  d: "ACTION4",
  ArrowRight: "ACTION4",
  j: "ACTION5",
  " ": "ACTION5",
  Enter: "ACTION5",
  f: "ACTION5",
  z: "ACTION7",
  u: "ACTION7",
  r: "RESET",
  Escape: "HELP",
};

const REPEATABLE_ACTIONS = new Set<ActionName>([
  "ACTION1",
  "ACTION2",
  "ACTION3",
  "ACTION4",
  "ACTION5",
  "ACTION7",
]);

const DEFAULT_CONSOLE_PRESSED_STATE: ConsolePressedState = {
  dpadDir: null,
  diamond: false,
  triangle: false,
  help: false,
  reset: false,
};

function normalizeBoundKey(key: string): string {
  if (key in KEY_TO_ACTION) {
    return key;
  }

  const lowered = key.toLowerCase();
  if (lowered in KEY_TO_ACTION) {
    return lowered;
  }

  return key;
}

function resolveKeyAction(key: string): ActionName | null {
  return KEY_TO_ACTION[normalizeBoundKey(key)] ?? null;
}

function deriveConsolePressedState(
  pressedKeys: Iterable<string>,
): ConsolePressedState {
  const pressedState: ConsolePressedState = {
    ...DEFAULT_CONSOLE_PRESSED_STATE,
  };

  for (const key of pressedKeys) {
    const action = resolveKeyAction(key);
    switch (action) {
      case "ACTION1":
        pressedState.dpadDir = "up";
        break;
      case "ACTION2":
        pressedState.dpadDir = "down";
        break;
      case "ACTION3":
        pressedState.dpadDir = "left";
        break;
      case "ACTION4":
        pressedState.dpadDir = "right";
        break;
      case "ACTION5":
        pressedState.diamond = true;
        break;
      case "ACTION7":
        pressedState.triangle = true;
        break;
      case "HELP":
        pressedState.help = true;
        break;
      case "RESET":
        pressedState.reset = true;
        break;
      default:
        break;
    }
  }

  return pressedState;
}

function isWinShareHotspotPoint(x: number, y: number): boolean {
  const bounds = WinSceneModule.SHARE_HOTSPOT_BOUNDS;
  return (
    x >= bounds.x &&
    x < bounds.x + bounds.width &&
    y >= bounds.y &&
    y < bounds.y + bounds.height
  );
}

export default function App() {
  const [firmware] = useState(
    () =>
      new Firmware({
        api: FIRMWARE_API,
        ensurePlayerId: getOrCreatePlayerId,
      }),
  );
  const [snapshot, setSnapshot] = useState<FirmwareSnapshot>(() =>
    firmware.getSnapshot(),
  );
  const [consolePressed, setConsolePressed] = useState<ConsolePressedState>(
    DEFAULT_CONSOLE_PRESSED_STATE,
  );
  const pressedKeysRef = useRef<Set<string>>(new Set());

  const dispatchShareFeedbackIfNeeded = useCallback(
    (action: ActionName, mode: ShareTransferMode) => {
      if (
        action === "ACTION5" &&
        snapshot.scene === "win" &&
        mode === "clipboard"
      ) {
        void firmware.dispatchAction(action);
      }
    },
    [firmware, snapshot.scene],
  );

  const handleConsoleAction = useCallback(
    (action: ActionName) => {
      if (action === "ACTION5" && snapshot.scene === "win") {
        return;
      }

      void firmware.dispatchAction(action);
    },
    [firmware, snapshot.scene],
  );

  const handleConsoleActionRelease = useCallback(
    (action: ActionName) => {
      const mode = firmware.tryCopyShareForAction(action);
      dispatchShareFeedbackIfNeeded(action, mode);
    },
    [dispatchShareFeedbackIfNeeded, firmware],
  );

  const handleConsoleScreenPress = useCallback(
    (x: number, y: number) => {
      if (snapshot.scene === "win" && isWinShareHotspotPoint(x, y)) {
        return;
      }

      const point = { x, y };
      void firmware.pressScreen(point);
    },
    [firmware, snapshot.scene],
  );

  const handleConsoleScreenRelease = useCallback(
    (x: number, y: number) => {
      const mode = firmware.tryCopyShareForPoint({ x, y });
      if (snapshot.scene !== "win" || mode !== "clipboard") {
        return;
      }

      void firmware.pressScreen({ x, y });
    },
    [firmware, snapshot.scene],
  );

  useEffect(() => {
    const unsubscribeSnapshot = firmware.on("snapshot", (nextSnapshot) => {
      startTransition(() => {
        setSnapshot(nextSnapshot);
      });
    });

    void firmware.boot();

    return () => {
      unsubscribeSnapshot();
      firmware.dispose();
    };
  }, [firmware]);

  useEffect(() => {
    const handlePageHide = () => {
      keepAliveUnloadDailySession(firmware.getActiveEditionDate());
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, [firmware]);

  const handleKeyboardAction = useEffectEvent((event: KeyboardEvent) => {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    const normalizedKey = normalizeBoundKey(event.key);
    const mappedAction = resolveKeyAction(normalizedKey);
    if (!mappedAction) {
      return;
    }

    event.preventDefault();

    if (snapshot.busy.inputLocked) {
      return;
    }

    if (event.repeat && !REPEATABLE_ACTIONS.has(mappedAction)) {
      return;
    }

    if (!pressedKeysRef.current.has(normalizedKey)) {
      pressedKeysRef.current.add(normalizedKey);
      setConsolePressed(deriveConsolePressedState(pressedKeysRef.current));
    }

    const mode = firmware.tryCopyShareForAction(mappedAction);
    if (mappedAction === "ACTION5" && snapshot.scene === "win") {
      dispatchShareFeedbackIfNeeded(mappedAction, mode);
      return;
    }

    void firmware.dispatchAction(mappedAction);
  });

  const handleKeyboardRelease = useEffectEvent((event: KeyboardEvent) => {
    const normalizedKey = normalizeBoundKey(event.key);
    const mappedAction = resolveKeyAction(normalizedKey);
    if (!mappedAction) {
      return;
    }

    pressedKeysRef.current.delete(normalizedKey);
    setConsolePressed(deriveConsolePressedState(pressedKeysRef.current));
  });

  const clearKeyboardPressedState = useEffectEvent(() => {
    if (pressedKeysRef.current.size === 0) {
      return;
    }

    pressedKeysRef.current.clear();
    setConsolePressed(DEFAULT_CONSOLE_PRESSED_STATE);
  });

  useEffect(() => {
    const keydownListener = (event: KeyboardEvent) =>
      handleKeyboardAction(event);
    const keyupListener = (event: KeyboardEvent) =>
      handleKeyboardRelease(event);
    const blurListener = () => clearKeyboardPressedState();

    window.addEventListener("keydown", keydownListener, { passive: false });
    window.addEventListener("keyup", keyupListener);
    window.addEventListener("blur", blurListener);

    return () => {
      window.removeEventListener("keydown", keydownListener);
      window.removeEventListener("keyup", keyupListener);
      window.removeEventListener("blur", blurListener);
    };
  }, []);

  return (
    <div className="app-shell">
      <ConwayBackground />
      <div className="app-foreground">
        <Console
          framebuffer={snapshot.framebuffer}
          controls={snapshot.controls}
          inputLocked={snapshot.busy.inputLocked}
          pressedState={consolePressed}
          screenInteractive={snapshot.screenInteractive}
          onAction={handleConsoleAction}
          onActionRelease={handleConsoleActionRelease}
          onHoverPointChange={(point) => firmware.setHoverPoint(point)}
          onScreenPress={handleConsoleScreenPress}
          onScreenRelease={handleConsoleScreenRelease}
        />
      </div>
    </div>
  );
}
