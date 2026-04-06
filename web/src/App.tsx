import {
  startTransition,
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
} from "./firmware/Firmware";
import type { HelpLink } from "./firmware/os";
import {
  fetchDailyPuzzle,
  openPlaySession,
  sendAction,
  type ActionName,
} from "./lib/api";
import { getOrCreatePlayerId } from "./lib/storage";

const HELP_LINKS: HelpLink[] = [
  { id: "author", label: "AUTHOR", href: undefined },
  { id: "github", label: "GITHUB", href: undefined },
];

const FIRMWARE_API: FirmwareApi = {
  fetchDailyPuzzle,
  openPlaySession,
  sendAction,
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
  z: "ACTION7",
  u: "ACTION7",
  r: "RESET",
  Escape: "HELP",
};

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

export default function App() {
  const [firmware] = useState(
    () =>
      new Firmware({
        api: FIRMWARE_API,
        helpLinks: HELP_LINKS,
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

  useEffect(() => {
    const unsubscribeSnapshot = firmware.on("snapshot", (nextSnapshot) => {
      startTransition(() => {
        setSnapshot(nextSnapshot);
      });
    });
    const unsubscribeOpenUrl = firmware.on("open-url", ({ href }) => {
      window.open(href, "_blank", "noopener,noreferrer");
    });

    void firmware.boot();

    return () => {
      unsubscribeSnapshot();
      unsubscribeOpenUrl();
      firmware.dispose();
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

    if (event.repeat) {
      return;
    }

    pressedKeysRef.current.add(normalizedKey);
    setConsolePressed(deriveConsolePressedState(pressedKeysRef.current));
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
          onAction={(action) => void firmware.dispatchAction(action)}
          onHoverPointChange={(point) => firmware.setHoverPoint(point)}
          onScreenPress={(x, y) => void firmware.pressScreen({ x, y })}
        />
      </div>
    </div>
  );
}
