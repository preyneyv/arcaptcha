import { startTransition, useEffect, useEffectEvent, useState } from "react";

import { ActionConsole } from "./components/ActionConsole";
import { GridFrame } from "./components/GridFrame";
import {
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
  grid: number[][];
  availableActions: ActionName[];
  countedActions: number;
  levelsCompleted: number;
  winLevels: number;
}

const KEY_TO_ACTION: Record<string, ActionName> = {
  r: "RESET",
  w: "ACTION1",
  ArrowUp: "ACTION1",
  s: "ACTION2",
  ArrowDown: "ACTION2",
  a: "ACTION3",
  ArrowLeft: "ACTION3",
  d: "ACTION4",
  ArrowRight: "ACTION4",
  f: "ACTION5",
  " ": "ACTION5",
};

function toPlaySession(session: SessionState): PlaySession {
  return {
    cardId: session.cardId,
    gameId: session.gameId,
    guid: session.guid,
  };
}

function formatShortDate(dateString: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateString}T00:00:00Z`));
}

function formatProgress(session: SessionState | null): string {
  if (!session) {
    return "--";
  }

  const goal = session.winLevels || session.levelsCompleted || 1;
  return `${session.levelsCompleted}/${goal}`;
}

function getStatusTone(params: {
  booting: boolean;
  busy: boolean;
  coordinateMode: boolean;
  error: string | null;
  solved: boolean;
}): "idle" | "busy" | "armed" | "win" | "error" {
  if (params.error) {
    return "error";
  }

  if (params.coordinateMode) {
    return "armed";
  }

  if (params.solved) {
    return "win";
  }

  if (params.booting || params.busy) {
    return "busy";
  }

  return "idle";
}

function getStatusLine(params: {
  booting: boolean;
  busy: boolean;
  coordinateMode: boolean;
  error: string | null;
  hasDaily: boolean;
  hasSession: boolean;
  solved: boolean;
  countedActions: number;
}): string {
  if (params.error) {
    return params.error;
  }

  if (!params.hasDaily || params.booting) {
    return "Loading daily cartridge";
  }

  if (!params.hasSession && params.busy) {
    return "Opening session";
  }

  if (params.coordinateMode) {
    return "Pick a tile";
  }

  if (params.solved) {
    return `Solved in ${params.countedActions}`;
  }

  if (params.busy) {
    return "Stepping";
  }

  return "Ready";
}

export default function App() {
  const [daily, setDaily] = useState<DailyPuzzle | null>(null);
  const [session, setSession] = useState<SessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [coordinateMode, setCoordinateMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOrCreatePlayerId();
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
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
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

  useEffect(() => {
    if (!daily || session || busy || error) {
      return;
    }

    void startSession(daily);
  }, [busy, daily, error, session]);

  const handleKeyboardAction = useEffectEvent((event: KeyboardEvent) => {
    if (event.repeat) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void triggerAction("ACTION7");
      return;
    }

    const mappedAction =
      KEY_TO_ACTION[event.key] ?? KEY_TO_ACTION[event.key.toLowerCase()];
    if (!mappedAction) {
      return;
    }

    event.preventDefault();
    void triggerAction(mappedAction);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyboardAction(event);
    window.addEventListener("keydown", listener, { passive: false });
    return () => window.removeEventListener("keydown", listener);
  }, []);

  async function startSession(puzzle: DailyPuzzle | null = daily) {
    if (!puzzle) {
      return;
    }

    setBusy(true);
    try {
      const opened = await openPlaySession(
        puzzle.resolvedGameId || puzzle.gameId,
      );
      startTransition(() => {
        setSession({
          cardId: opened.session.cardId,
          gameId: opened.session.gameId,
          guid: opened.frame.guid,
          state: opened.frame.state,
          grid: opened.frame.grid,
          availableActions: opened.frame.availableActions,
          countedActions: 1,
          levelsCompleted: opened.frame.levelsCompleted,
          winLevels: opened.frame.winLevels,
        });
        setCoordinateMode(false);
        setError(null);
      });
    } catch (sessionError) {
      setError(
        sessionError instanceof Error
          ? sessionError.message
          : String(sessionError),
      );
    } finally {
      setBusy(false);
    }
  }

  async function triggerAction(
    action: ActionName,
    target?: { x: number; y: number },
  ) {
    if (!daily) {
      return;
    }

    if (!session) {
      if (action === "RESET") {
        await startSession(daily);
      }
      return;
    }

    if (action === "ACTION6" && !target) {
      if (session.availableActions.includes("ACTION6")) {
        setCoordinateMode(true);
      }
      return;
    }

    if (!session.availableActions.includes(action) && action !== "RESET") {
      return;
    }

    const activeSession = session;
    setBusy(true);

    try {
      const nextFrame = await sendAction(
        action,
        toPlaySession(activeSession),
        target ? { x: target.x, y: target.y } : {},
      );

      const nextSession: SessionState = {
        ...activeSession,
        guid: nextFrame.guid,
        state: nextFrame.state,
        grid: nextFrame.grid,
        availableActions: nextFrame.availableActions,
        countedActions:
          action === "RESET" ? 1 : activeSession.countedActions + 1,
        levelsCompleted: nextFrame.levelsCompleted,
        winLevels: nextFrame.winLevels,
      };

      startTransition(() => {
        setSession(nextSession);
        setCoordinateMode(false);
        setError(null);
      });
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : String(actionError),
      );
    } finally {
      setBusy(false);
    }
  }
  const availableActions =
    session?.availableActions ?? (daily ? ["RESET"] : []);
  const solved = session?.state === "WIN";
  const statusTone = getStatusTone({
    booting,
    busy,
    coordinateMode,
    error,
    solved,
  });
  const statusLine = getStatusLine({
    booting,
    busy,
    coordinateMode,
    error,
    hasDaily: Boolean(daily),
    hasSession: Boolean(session),
    solved,
    countedActions: session?.countedActions ?? 0,
  });
  const modeChip = daily
    ? daily.isReplay
      ? `cycle ${daily.cycle}`
      : "daily"
    : "sync";
  const referenceLine =
    daily?.referenceRevealed && daily.referenceActionCount !== null
      ? `ref ${daily.referenceActionCount}`
      : "ref --";
  const sessionState = session?.state ?? (booting ? "BOOT" : "IDLE");

  return (
    <div className="app-shell">
      <main className="console-stage">
        <section className="console-shell" data-armed={coordinateMode}>
          <div
            className="console-corner console-corner-top"
            aria-hidden="true"
          />
          <div
            className="console-corner console-corner-bottom"
            aria-hidden="true"
          />

          <section className="screen-bay" aria-label="Game screen">
            <div className="screen-shell-header" aria-hidden="true">
              <span className="screen-shell-stripe" />
              <span className="screen-shell-brand">Arcaptcha</span>
              <span className="screen-shell-stripe" />
            </div>

            <div className="screen-frame">
              <div className="screen-readout top">
                <span className="screen-line">
                  <span>cart {daily?.gameId ?? "--"}</span>
                  <span>{daily ? formatShortDate(daily.date) : "sync"}</span>
                </span>
                <span className="screen-line screen-line-strong">
                  <span>{daily?.title ?? "Loading puzzle"}</span>
                  <span>{modeChip}</span>
                </span>
              </div>

              <div className="screen-playfield">
                <GridFrame
                  grid={session?.grid ?? []}
                  coordinateMode={coordinateMode}
                  onCellSelect={(x, y) =>
                    void triggerAction("ACTION6", { x, y })
                  }
                />
              </div>

              <div className="screen-readout bottom">
                <span className="screen-line screen-line-strong compact">
                  <span>
                    {session ? `mv ${session.countedActions}` : "mv --"}
                  </span>
                  <span>{`lv ${formatProgress(session)}`}</span>
                  <span>{referenceLine}</span>
                </span>

                <span
                  className="screen-line screen-statusline"
                  data-status={statusTone}
                >
                  <span className="status-led" aria-hidden="true" />
                  <span className="screen-status-copy">{statusLine}</span>
                  <span>{sessionState}</span>
                </span>
              </div>
            </div>
          </section>

          <div className="console-brandband" aria-hidden="true">
            <span className="console-mark">Arcaptcha</span>
            <span className="console-model">arc-01 puzzle system</span>
          </div>

          <div className="speaker-strip" aria-hidden="true" />

          <ActionConsole
            availableActions={availableActions}
            coordinateMode={coordinateMode}
            busy={busy}
            onAction={(action) => void triggerAction(action)}
          />
        </section>
      </main>
    </div>
  );
}
