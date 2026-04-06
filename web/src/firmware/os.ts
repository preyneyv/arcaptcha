import type { ActionName, DailyPuzzle } from "../lib/api";
import type { Framebuffer } from "./framebuffer";

export type SceneKind = "help" | "about" | "play" | "win" | "error";

export interface SessionSnapshot {
  state: string;
  grid: number[][];
  availableActions: ActionName[];
  countedActions: number;
  levelsCompleted: number;
  winLevels: number;
  levelActionCounts: number[];
}

export type PostGameOutcome = "win" | "fail";

export type PostGameBand = "red" | "yellow" | "green" | "blue" | "neutral";

export const PERFORMANCE_BAND_THRESHOLDS = {
  blueAbove: 105,
  greenAtLeast: 98,
  yellowAtLeast: 85,
} as const;

export function getPerformanceBand(scorePercent: number | null): PostGameBand {
  if (scorePercent === null) {
    return "neutral";
  }

  if (scorePercent > PERFORMANCE_BAND_THRESHOLDS.blueAbove) {
    return "blue";
  }

  if (scorePercent >= PERFORMANCE_BAND_THRESHOLDS.greenAtLeast) {
    return "green";
  }

  if (scorePercent >= PERFORMANCE_BAND_THRESHOLDS.yellowAtLeast) {
    return "yellow";
  }

  return "red";
}

export function getLevelScorePercent(
  userLevelActions: number | null | undefined,
  baselineLevelActions: number | null | undefined,
): number | null {
  if (
    userLevelActions == null ||
    baselineLevelActions == null ||
    !Number.isFinite(userLevelActions) ||
    !Number.isFinite(baselineLevelActions)
  ) {
    return null;
  }

  const normalizedUserActions = Math.max(0, Math.trunc(userLevelActions));
  const normalizedBaselineActions = Math.max(
    0,
    Math.trunc(baselineLevelActions),
  );
  if (normalizedUserActions <= 0 || normalizedBaselineActions <= 0) {
    return null;
  }

  return Math.round((normalizedBaselineActions / normalizedUserActions) * 100);
}

export interface PostGameLevelMetric {
  level: number;
  band: PostGameBand;
}

export interface PostGameStats {
  outcome: PostGameOutcome;
  headline: string;
  detail: string;
  countedActions: number;
  baselineActions: number | null;
  deltaActions: number | null;
  scorePercent: number | null;
  levelsCompleted: number;
  winLevels: number;
  levelMetrics: PostGameLevelMetric[];
  shareText: string;
}

export interface HelpLink {
  id: string;
  label: string;
  href?: string | null;
}

export interface HoverPoint {
  x: number;
  y: number;
}

export interface ControlState {
  ACTION1: boolean;
  ACTION2: boolean;
  ACTION3: boolean;
  ACTION4: boolean;
  ACTION5: boolean;
  ACTION6: boolean;
  ACTION7: boolean;
  HELP: boolean;
  RESET: boolean;
}

export type MenuActionId = "play" | "about" | "back";

export type InteractiveRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
} & (
  | { kind: "link"; href?: string | null }
  | { kind: "action"; action: MenuActionId }
);

export interface FirmwareModel {
  scene: SceneKind;
  daily: DailyPuzzle | null;
  session: SessionSnapshot | null;
  postGame: PostGameStats | null;
  hoverPoint: HoverPoint | null;
  clickPoint: HoverPoint | null;
  busy: boolean;
  error: string | null;
}

export interface FirmwareFrame {
  framebuffer: Framebuffer;
  controls: ControlState;
  hotspots: InteractiveRegion[];
  scene: SceneKind;
}

export function getNextHelpSelection(
  current: number | null,
  delta: number,
  items: readonly HelpLink[],
): number | null {
  if (items.length === 0) {
    return null;
  }

  if (current === null) {
    return delta >= 0 ? 0 : items.length - 1;
  }

  return (current + delta + items.length) % items.length;
}

export function findHotspot(
  hotspots: readonly InteractiveRegion[],
  x: number,
  y: number,
): InteractiveRegion | null {
  return (
    hotspots.find(
      (hotspot) =>
        x >= hotspot.x &&
        x < hotspot.x + hotspot.width &&
        y >= hotspot.y &&
        y < hotspot.y + hotspot.height,
    ) ?? null
  );
}
