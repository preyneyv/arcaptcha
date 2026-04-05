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

interface ActionConsoleProps {
  availableActions: ActionName[];
  coordinateMode: boolean;
  busy: boolean;
  onAction: (action: ActionName) => void;
}

export function ActionConsole({
  availableActions,
  coordinateMode,
  busy,
  onAction,
}: ActionConsoleProps) {
  const availableSet = new Set(availableActions);
  const resetEnabled = availableSet.has("RESET");
  const undoEnabled = availableSet.has("ACTION7");
  const actEnabled = availableSet.has("ACTION5");
  const aimEnabled = availableSet.has("ACTION6");

  return (
    <section className="control-bay">
      <div className="control-grid">
        <div className="dpad-cluster">
          <div className="dpad">
            {DIRECTION_CONTROLS.map((control) => {
              const enabled = availableSet.has(control.action);
              return (
                <button
                  key={control.action}
                  type="button"
                  className={`dpad-button ${control.className}`}
                  data-enabled={enabled}
                  disabled={!enabled || busy}
                  onClick={() => onAction(control.action)}
                  aria-label={control.label}
                >
                  <span className="dpad-arrow" aria-hidden="true" />
                </button>
              );
            })}
            <div className="dpad-core" aria-hidden="true" />
          </div>

          <div className="control-labels" aria-hidden="true">
            <span>move</span>
            <span>wasd</span>
          </div>
        </div>

        <div className="face-cluster">
          <div className="face-buttons">
            <button
              type="button"
              className="face-button action-aim"
              data-enabled={aimEnabled}
              aria-pressed={coordinateMode}
              disabled={!aimEnabled || busy}
              onClick={() => onAction("ACTION6")}
            >
              <span className="face-letter">B</span>
            </button>

            <button
              type="button"
              className="face-button action-act"
              data-enabled={actEnabled}
              disabled={!actEnabled || busy}
              onClick={() => onAction("ACTION5")}
            >
              <span className="face-letter">A</span>
            </button>
          </div>

          <div className="control-labels face-labels" aria-hidden="true">
            <span>B aim</span>
            <span>A act</span>
          </div>
        </div>
      </div>

      <div className="system-strip">
        <button
          type="button"
          className="system-button"
          data-enabled={resetEnabled}
          disabled={!resetEnabled || busy}
          onClick={() => onAction("RESET")}
        >
          reset
        </button>

        <button
          type="button"
          className="system-button"
          data-enabled={undoEnabled}
          disabled={!undoEnabled || busy}
          onClick={() => onAction("ACTION7")}
        >
          undo
        </button>
      </div>
    </section>
  );
}
