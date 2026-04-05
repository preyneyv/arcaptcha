import {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import { Console, type ConsolePressedState } from "./components/Console";
import { ConwayBackground } from "./components/ConwayBackground";
import { GAMEPLAY_HEIGHT, GAMEPLAY_SCALE } from "./firmware/framebuffer";
import {
  findHotspot,
  getNextHelpSelection,
  renderFirmware,
  type FirmwareModel,
  type HelpLink,
  type HoverPoint,
  type SceneKind,
  type SessionSnapshot,
} from "./firmware/os";
import {
  ApiRequestError,
  fetchDailyPuzzle,
  openPlaySession,
  sendAction,
  type ActionName,
  type DailyPuzzle,
  type PlaySession,
} from "./lib/api";
import { getOrCreatePlayerId } from "./lib/storage";

interface SessionState {
  cardId: string;
  gameId: string;
  guid: string | null;
  state: string;
  frames: number[][][];
  grid: number[][];
  availableActions: ActionName[];
  countedActions: number;
  levelsCompleted: number;
  winLevels: number;
}

const FRAME_PLAYBACK_INTERVAL_MS = 1000 / 15;
const CURSOR_CLICK_PULSE_MS = 140;

const HELP_LINKS: HelpLink[] = [
  { id: "author", label: "AUTHOR", href: undefined },
  { id: "github", label: "GITHUB", href: undefined },
];

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

function toPlaySession(session: SessionState): PlaySession {
  return {
    cardId: session.cardId,
    gameId: session.gameId,
    guid: session.guid,
  };
}

function toSessionSnapshot(
  session: SessionState | null,
  displayGrid: number[][] | null,
): SessionSnapshot | null {
  if (!session) {
    return null;
  }

  return {
    state: session.state,
    grid: displayGrid ?? session.grid,
    availableActions: session.availableActions,
    countedActions: session.countedActions,
    levelsCompleted: session.levelsCompleted,
    winLevels: session.winLevels,
  };
}

function getFrameSequence(session: SessionState | null): number[][][] {
  if (!session) {
    return [];
  }

  if (session.frames.length > 0) {
    return session.frames;
  }

  return session.grid.length > 0 ? [session.grid] : [];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preferSessionGameId(
  currentGameId: string,
  nextGameId: string,
): string {
  if (nextGameId && nextGameId.includes("-")) {
    return nextGameId;
  }

  return currentGameId;
}

function isSessionIdentityError(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.status === 404 ||
    message.includes("not found") ||
    message.includes("missing `guid`") ||
    message.includes("does not match api key") ||
    message.includes("has not been started")
  );
}

export default function App() {
  const [daily, setDaily] = useState<DailyPuzzle | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [scene, setScene] = useState<SceneKind>("help");
  const [busy, setBusy] = useState(false);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [startedOnce, setStartedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [helpSelection, setHelpSelection] = useState<number | null>(null);
  const [consolePressed, setConsolePressed] = useState<ConsolePressedState>(
    DEFAULT_CONSOLE_PRESSED_STATE,
  );
  const [hoverPoint, setHoverPoint] = useState<HoverPoint | null>(null);
  const [clickPoint, setClickPoint] = useState<HoverPoint | null>(null);
  const [displayGrid, setDisplayGrid] = useState<number[][] | null>(null);
  const latestSessionRef = useRef<SessionState | null>(null);
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const startSessionPromiseRef = useRef<Promise<void> | null>(null);
  const pendingSessionRevealRef = useRef(false);
  const playbackTimerRef = useRef<number | null>(null);
  const clickPulseTimerRef = useRef<number | null>(null);
  const inputBusy = busy || playbackBusy;
  const hoverEnabled =
    scene === "play" &&
    !inputBusy &&
    !error &&
    Boolean(session?.availableActions.includes("ACTION6"));

  function stopPlayback() {
    if (playbackTimerRef.current !== null) {
      window.clearInterval(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
  }

  function stopClickPulse() {
    if (clickPulseTimerRef.current !== null) {
      window.clearTimeout(clickPulseTimerRef.current);
      clickPulseTimerRef.current = null;
    }
  }

  useEffect(() => {
    getOrCreatePlayerId();
  }, []);

  useEffect(() => {
    latestSessionRef.current = session;
  }, [session]);

  useEffect(() => {
    return () => {
      stopClickPulse();
    };
  }, []);

  useEffect(() => {
    if (hoverEnabled) {
      return;
    }

    setHoverPoint((current) => (current === null ? current : null));
  }, [hoverEnabled]);

  useEffect(() => {
    stopPlayback();
    setPlaybackBusy(false);

    const frames = getFrameSequence(session);
    if (frames.length === 0) {
      setDisplayGrid(null);
      return;
    }

    setDisplayGrid(frames[0] ?? null);
    if (frames.length === 1) {
      return;
    }

    setPlaybackBusy(true);
    let frameIndex = 0;
    playbackTimerRef.current = window.setInterval(() => {
      frameIndex += 1;
      const nextGrid = frames[Math.min(frameIndex, frames.length - 1)] ?? null;
      startTransition(() => {
        setDisplayGrid(nextGrid);
      });

      if (frameIndex >= frames.length - 1) {
        setPlaybackBusy(false);
        stopPlayback();
      }
    }, FRAME_PLAYBACK_INTERVAL_MS);

    return () => {
      setPlaybackBusy(false);
      stopPlayback();
    };
  }, [session]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 320);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setBooting(true);
      try {
        const nextDaily = await fetchDailyPuzzle();
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setDaily(nextDaily);
          setError(null);
        });
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const firmwareModel = useMemo<FirmwareModel>(
    () => ({
      scene,
      daily,
      session: toSessionSnapshot(session, displayGrid),
      hoverPoint: hoverEnabled ? hoverPoint : null,
      clickPoint,
      busy: inputBusy,
      startedOnce,
      blinkVisible: tick % 2 === 0,
      error,
      helpSelection,
      helpLinks: HELP_LINKS,
    }),
    [
      daily,
      displayGrid,
      error,
      helpSelection,
      clickPoint,
      hoverPoint,
      hoverEnabled,
      inputBusy,
      scene,
      session,
      startedOnce,
      tick,
    ],
  );

  const firmwareFrame = useMemo(
    () => renderFirmware(firmwareModel),
    [firmwareModel],
  );

  async function startSession(options?: { revealScene?: boolean }) {
    if (!daily) {
      return;
    }

    const revealScene = options?.revealScene ?? true;
    if (revealScene) {
      pendingSessionRevealRef.current = true;
    }

    if (startSessionPromiseRef.current) {
      await startSessionPromiseRef.current;
      return;
    }

    const startTask = (async () => {
      setBusy(true);
      try {
        const opened = await openPlaySession(
          daily.resolvedGameId || daily.gameId,
        );
        const shouldReveal = pendingSessionRevealRef.current;

        startTransition(() => {
          setSession({
            cardId: opened.session.cardId,
            gameId: opened.session.gameId,
            guid: opened.frame.guid,
            state: opened.frame.state,
            frames: opened.frame.frame,
            grid: opened.frame.grid,
            availableActions: opened.frame.availableActions,
            countedActions: 1,
            levelsCompleted: opened.frame.levelsCompleted,
            winLevels: opened.frame.winLevels,
          });
          if (shouldReveal) {
            setScene(opened.frame.state === "WIN" ? "win" : "play");
            setStartedOnce(true);
            setHelpSelection(null);
          }
          setError(null);
        });
      } catch (sessionError) {
        startTransition(() => {
          setSession(null);
          setScene("help");
          setHelpSelection(null);
          setError(getErrorMessage(sessionError));
        });
      } finally {
        pendingSessionRevealRef.current = false;
        setBusy(false);
      }
    })();

    startSessionPromiseRef.current = startTask;
    try {
      await startTask;
    } finally {
      if (startSessionPromiseRef.current === startTask) {
        startSessionPromiseRef.current = null;
      }
    }
  }

  useEffect(() => {
    if (!daily || session || inputBusy || error || booting) {
      return;
    }

    void startSession({ revealScene: false });
  }, [booting, daily, error, inputBusy, session]);

  async function runGameAction(
    action: Exclude<ActionName, "HELP">,
    extraData: Record<string, unknown> = {},
  ) {
    const activeSession = latestSessionRef.current;
    if (!activeSession) {
      await startSession();
      return;
    }

    setBusy(true);
    try {
      const nextFrame = await sendAction(
        action,
        toPlaySession(activeSession),
        extraData,
      );

      startTransition(() => {
        setSession({
          ...activeSession,
          gameId: preferSessionGameId(activeSession.gameId, nextFrame.gameId),
          guid: nextFrame.guid,
          state: nextFrame.state,
          frames: nextFrame.frame,
          grid: nextFrame.grid,
          availableActions: nextFrame.availableActions,
          countedActions:
            action === "RESET" ? 1 : activeSession.countedActions + 1,
          levelsCompleted: nextFrame.levelsCompleted,
          winLevels: nextFrame.winLevels,
        });
        setStartedOnce(true);
        setError(null);
        setScene((currentScene) => {
          if (currentScene === "help") {
            return currentScene;
          }
          return nextFrame.state === "WIN" ? "win" : "play";
        });
      });
    } catch (actionError) {
      startTransition(() => {
        if (isSessionIdentityError(actionError)) {
          setSession(null);
          setScene("help");
          setHelpSelection(null);
        }
        setError(getErrorMessage(actionError));
      });
    } finally {
      setBusy(false);
    }
  }

  async function resumeOrStart() {
    if (!session) {
      await startSession();
      return;
    }

    startTransition(() => {
      setScene(session.state === "WIN" ? "win" : "play");
      setStartedOnce(true);
      setError(null);
      setHelpSelection(null);
    });
  }

  function openHelpLink(link: HelpLink | undefined) {
    if (!link?.href) {
      return;
    }

    window.open(link.href, "_blank", "noopener,noreferrer");
  }

  const handleAction = useEffectEvent(async (action: ActionName) => {
    if (action === "HELP") {
      startTransition(() => {
        setScene("help");
        setError(null);
      });
      return;
    }

    if (error) {
      if (action === "RESET") {
        await startSession();
        return;
      }

      startTransition(() => {
        setError(null);
        setScene("help");
      });
      return;
    }

    if (scene === "help") {
      const canQueueSessionReveal = inputBusy && startSessionPromiseRef.current;
      if (
        inputBusy &&
        !canQueueSessionReveal &&
        action !== "ACTION1" &&
        action !== "ACTION2" &&
        action !== "ACTION3" &&
        action !== "ACTION4"
      ) {
        return;
      }

      if (action === "RESET") {
        await startSession();
        return;
      }

      if (action === "ACTION1" || action === "ACTION3") {
        setHelpSelection((current) =>
          getNextHelpSelection(current, -1, HELP_LINKS),
        );
        return;
      }

      if (action === "ACTION2" || action === "ACTION4") {
        setHelpSelection((current) =>
          getNextHelpSelection(current, 1, HELP_LINKS),
        );
        return;
      }

      if (action === "ACTION5") {
        if (helpSelection !== null) {
          openHelpLink(HELP_LINKS[helpSelection]);
          return;
        }

        await resumeOrStart();
        return;
      }

      await resumeOrStart();
      return;
    }

    if (scene === "win") {
      if (action === "RESET") {
        await runGameAction("RESET");
      }
      return;
    }

    if (!firmwareFrame.controls[action] || inputBusy) {
      return;
    }

    await runGameAction(action);
  });

  const handleScreenPress = useEffectEvent(async (x: number, y: number) => {
    if (error) {
      return;
    }

    if (scene === "help") {
      if (inputBusy && !startSessionPromiseRef.current) {
        return;
      }

      const hotspot = findHotspot(firmwareFrame.hotspots, x, y);
      if (hotspot?.kind === "link") {
        openHelpLink(HELP_LINKS.find((link) => link.id === hotspot.id));
        return;
      }

      await resumeOrStart();
      return;
    }

    if (
      scene !== "play" ||
      !session ||
      inputBusy ||
      !firmwareFrame.controls.ACTION6
    ) {
      return;
    }

    if (y >= GAMEPLAY_HEIGHT) {
      return;
    }

    pulseClickCursor({ x, y });

    const targetX = Math.max(0, Math.min(63, Math.floor(x / GAMEPLAY_SCALE)));
    const targetY = Math.max(0, Math.min(63, Math.floor(y / GAMEPLAY_SCALE)));

    await runGameAction("ACTION6", { x: targetX, y: targetY });
  });

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

    if (inputBusy) {
      return;
    }

    if (event.repeat) {
      return;
    }

    pressedKeysRef.current.add(normalizedKey);
    setConsolePressed(deriveConsolePressedState(pressedKeysRef.current));
    void handleAction(mappedAction);
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

  const handleHoverPointChange = useEffectEvent(
    (nextPoint: HoverPoint | null) => {
      setHoverPoint((current) => {
        if (nextPoint === null) {
          return current === null ? current : null;
        }

        if (current?.x === nextPoint.x && current.y === nextPoint.y) {
          return current;
        }

        return nextPoint;
      });
    },
  );

  const pulseClickCursor = useEffectEvent((nextPoint: HoverPoint) => {
    stopClickPulse();
    setClickPoint(nextPoint);
    clickPulseTimerRef.current = window.setTimeout(() => {
      clickPulseTimerRef.current = null;
      setClickPoint(null);
    }, CURSOR_CLICK_PULSE_MS);
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
          framebuffer={firmwareFrame.framebuffer}
          controls={firmwareFrame.controls}
          inputLocked={inputBusy}
          pressedState={consolePressed}
          onAction={(action) => void handleAction(action)}
          onHoverPointChange={handleHoverPointChange}
          onScreenPress={(x, y) => void handleScreenPress(x, y)}
        />
      </div>
    </div>
  );
}
