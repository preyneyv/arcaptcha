import { Console } from "./components/Console";
import { ConwayBackground } from "./components/ConwayBackground";
import { type ActionName } from "./lib/api";

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

export default function App() {
  return (
    <div className="app-shell">
      <ConwayBackground />
      <div className="app-foreground">
        <Console />
      </div>
    </div>
  );
}
