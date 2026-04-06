import type { ActionName, DailyPuzzle } from "../lib/api";
import { drawText, getLineHeight, measureText, wrapText } from "./font";
import {
  blitArcGrid,
  blitSprite,
  clearFramebuffer,
  createFramebuffer,
  drawGridCursor,
  fillRect,
  GAMEPLAY_HEIGHT,
  GAMEPLAY_SCALE,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  strokeRect,
  type Framebuffer,
} from "./framebuffer";
import { UI_COLORS } from "./palette";
import { SPIRTE_PLAY, SPRITE_CONTROLS_DISABLED, SPRITE_LOGO } from "./sprites";

export type SceneKind = "help" | "play" | "win" | "error";

export interface SessionSnapshot {
  state: string;
  grid: number[][];
  availableActions: ActionName[];
  countedActions: number;
  levelsCompleted: number;
  winLevels: number;
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

export type InteractiveRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
} & (
  | { kind: "link"; href?: string | null }
  | { kind: "callback"; callback: () => void }
);

export interface FirmwareModel {
  scene: SceneKind;
  daily: DailyPuzzle | null;
  session: SessionSnapshot | null;
  hoverPoint: HoverPoint | null;
  clickPoint: HoverPoint | null;
  busy: boolean;
  startedOnce: boolean;
  blinkVisible: boolean;
  error: string | null;
  helpSelection: number | null;
  helpLinks: HelpLink[];
}

export interface FirmwareFrame {
  framebuffer: Framebuffer;
  controls: ControlState;
  hotspots: InteractiveRegion[];
  scene: SceneKind;
}

function createControlState(defaultValue: boolean = false): ControlState {
  return {
    ACTION1: defaultValue,
    ACTION2: defaultValue,
    ACTION3: defaultValue,
    ACTION4: defaultValue,
    ACTION5: defaultValue,
    ACTION6: defaultValue,
    ACTION7: defaultValue,
    HELP: defaultValue,
    RESET: defaultValue,
  };
}

function truncateText(text: string, maxWidth: number): string {
  if (measureText(text, "large") <= maxWidth) {
    return text;
  }

  let candidate = text.toUpperCase();
  while (
    candidate.length > 0 &&
    measureText(`${candidate}.`, "large") > maxWidth
  ) {
    candidate = candidate.slice(0, -1);
  }
  return candidate ? `${candidate}.` : "";
}

function drawTextRight(
  framebuffer: Framebuffer,
  right: number,
  y: number,
  text: string,
  color: number,
): void {
  drawText(
    framebuffer,
    right - measureText(text, "small"),
    y,
    text,
    color,
    "small",
  );
}

function getEnvironmentControlTokens(actions: readonly ActionName[]): string[] {
  const tokens: string[] = [];

  if (actions.includes("ACTION1")) {
    tokens.push("UP");
  }
  if (actions.includes("ACTION2")) {
    tokens.push("DN");
  }
  if (actions.includes("ACTION3")) {
    tokens.push("LT");
  }
  if (actions.includes("ACTION4")) {
    tokens.push("RT");
  }
  if (actions.includes("ACTION5")) {
    tokens.push("DIA");
  }
  if (actions.includes("ACTION6")) {
    tokens.push("CLK");
  }
  if (actions.includes("ACTION7")) {
    tokens.push("TRI");
  }

  return tokens;
}

function wrapTokens(
  tokens: readonly string[],
  maxWidth: number,
  size: "small" | "large",
): string[] {
  if (tokens.length === 0) {
    return ["SYNC"];
  }

  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const candidate = current ? `${current} ${token}` : token;
    if (measureText(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
    }
    current = token;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function buildGameplayControls(model: FirmwareModel): ControlState {
  const controls = createControlState(false);
  controls.HELP = true;

  if (!model.daily) {
    return controls;
  }

  controls.RESET = true;

  if (!model.session) {
    return controls;
  }

  for (const action of model.session.availableActions) {
    if (action !== "HELP") {
      controls[action] = true;
    }
  }

  return controls;
}

function buildHelpControls(): ControlState {
  return createControlState(true);
}

function buildWinControls(model: FirmwareModel): ControlState {
  const controls = createControlState(false);
  controls.HELP = true;
  controls.RESET = Boolean(model.daily);
  return controls;
}

function buildErrorControls(model: FirmwareModel): ControlState {
  const controls = createControlState(false);
  controls.HELP = true;
  controls.RESET = Boolean(model.daily);
  return controls;
}

function renderHelpScene(model: FirmwareModel): FirmwareFrame {
  const framebuffer = createFramebuffer(UI_COLORS.background);
  const controls = buildHelpControls();
  const hotspots: InteractiveRegion[] = [];
  const prompt = model.startedOnce ? "TO RESUME" : "TO START";
  const titleLines = wrapText(
    truncateText(model.daily?.title ?? "LOADING", SCREEN_WIDTH - 8),
    SCREEN_WIDTH - 8,
    "large",
  ).slice(0, 2);
  const controlLines = wrapTokens(
    getEnvironmentControlTokens(model.session?.availableActions ?? []),
    SCREEN_WIDTH - 8,
    "large",
  ).slice(0, 3);
  const largeLineHeight = getLineHeight("large");
  const linkLineHeight = getLineHeight("large");

  clearFramebuffer(framebuffer, UI_COLORS.background);

  blitSprite(framebuffer, SPRITE_LOGO);
  blitSprite(framebuffer, SPRITE_CONTROLS_DISABLED, 16, 57);

  blitSprite(framebuffer, SPIRTE_PLAY, 37, 100);
  hotspots.push({
    id: "play",
    kind: "callback",
    callback: () => {
      console.log("Play button clicked");
    },
    x: 35,
    y: 98,
    width: SPIRTE_PLAY.width + 4,
    height: SPIRTE_PLAY.height + 4,
  });

  drawText(framebuffer, 50, 125, "ABOUT", UI_COLORS.textMuted, "large");
  hotspots.push({
    id: "about",
    kind: "callback",
    callback: () => {
      console.log("About button clicked");
    },
    x: 48,
    y: 123,
    width: 33,
    height: 11,
  });

  // titleLines.forEach((line, index) => {
  //   drawText(
  //     framebuffer,
  //     4,
  //     32 + index * largeLineHeight,
  //     line,
  //     UI_COLORS.text,
  //     "large",
  //   );
  // });

  // drawText(framebuffer, 4, 50, "ENABLED", UI_COLORS.textMuted, "large");
  // controlLines.forEach((line, index) => {
  //   drawText(
  //     framebuffer,
  //     4,
  //     59 + index * largeLineHeight,
  //     line,
  //     UI_COLORS.text,
  //     "large",
  //   );
  // });

  // const promptColor = model.blinkVisible ? UI_COLORS.text : UI_COLORS.textMuted;
  // drawText(framebuffer, 4, 94, "PRESS ANY BUTTON", promptColor, "large");
  // drawText(framebuffer, 4, 103, prompt, promptColor, "large");

  // drawText(framebuffer, 4, 114, "LINKS", UI_COLORS.textMuted, "large");
  // model.helpLinks.forEach((link, index) => {
  //   const y = 123 + index * linkLineHeight;
  //   const isSelected = model.helpSelection === index;
  //   if (isSelected) {
  //     fillRect(
  //       framebuffer,
  //       2,
  //       y - 1,
  //       SCREEN_WIDTH - 4,
  //       linkLineHeight,
  //       UI_COLORS.selection,
  //     );
  //   }
  //   drawText(
  //     framebuffer,
  //     6,
  //     y,
  //     link.label,
  //     isSelected
  //       ? UI_COLORS.textInverse
  //       : link.href
  //         ? UI_COLORS.text
  //         : UI_COLORS.textMuted,
  //     "large",
  //   );
  //   hotspots.push({
  //     id: link.id,
  //     kind: "link",
  //     href: link.href,
  //     x: 2,
  //     y: y - 1,
  //     width: SCREEN_WIDTH - 4,
  //     height: linkLineHeight,
  //   });
  // });

  const hoveredHotspot =
    model.hoverPoint === null
      ? null
      : findHotspot(hotspots, model.hoverPoint.x, model.hoverPoint.y);
  if (hoveredHotspot) {
    strokeRect(
      framebuffer,
      hoveredHotspot.x,
      hoveredHotspot.y,
      hoveredHotspot.width,
      hoveredHotspot.height,
      UI_COLORS.warning,
    );
  }

  return {
    framebuffer,
    controls,
    hotspots,
    scene: "help",
  };
}

function renderGameplayScene(model: FirmwareModel): FirmwareFrame {
  const framebuffer = createFramebuffer(UI_COLORS.backgroundStrong);
  const controls = buildGameplayControls(model);

  clearFramebuffer(framebuffer, UI_COLORS.backgroundStrong);

  if (model.session?.grid.length) {
    blitArcGrid(framebuffer, model.session.grid);
    const cursorPoint = model.clickPoint ?? model.hoverPoint;
    if (
      controls.ACTION6 &&
      cursorPoint &&
      cursorPoint.y < GAMEPLAY_HEIGHT &&
      (!model.busy || model.clickPoint)
    ) {
      const maxCellX = Math.floor((SCREEN_WIDTH - 1) / GAMEPLAY_SCALE);
      const maxCellY = Math.floor((GAMEPLAY_HEIGHT - 1) / GAMEPLAY_SCALE);
      const cellX = Math.floor(cursorPoint.x / GAMEPLAY_SCALE);
      const cellY = Math.floor(cursorPoint.y / GAMEPLAY_SCALE);
      drawGridCursor(
        framebuffer,
        Math.max(0, Math.min(maxCellX, cellX)),
        Math.max(0, Math.min(maxCellY, cellY)),
        UI_COLORS.warning,
        model.clickPoint ? 2 : 1,
      );
    }
  } else {
    fillRect(
      framebuffer,
      0,
      0,
      SCREEN_WIDTH,
      GAMEPLAY_HEIGHT,
      UI_COLORS.background,
    );
    drawText(framebuffer, 20, 58, "NO FRAME", UI_COLORS.text, "large");
  }

  fillRect(
    framebuffer,
    0,
    GAMEPLAY_HEIGHT,
    SCREEN_WIDTH,
    12,
    UI_COLORS.background,
  );
  fillRect(framebuffer, 0, GAMEPLAY_HEIGHT, SCREEN_WIDTH, 1, UI_COLORS.border);
  const title = truncateText(model.daily?.gameId ?? "SYNC", 64);
  const goal = model.session?.winLevels || model.session?.levelsCompleted || 1;
  const progress = `${model.session?.levelsCompleted ?? 0}/${goal}`;
  drawText(framebuffer, 2, 131, title, UI_COLORS.text, "small");
  drawTextRight(
    framebuffer,
    SCREEN_WIDTH - 2,
    131,
    progress,
    UI_COLORS.textInverse,
  );

  return {
    framebuffer,
    controls,
    hotspots: [],
    scene: "play",
  };
}

function renderWinScene(model: FirmwareModel): FirmwareFrame {
  const framebuffer = createFramebuffer(UI_COLORS.background);
  clearFramebuffer(framebuffer, UI_COLORS.background);
  drawText(framebuffer, 34, 58, "COMPLETE", UI_COLORS.text, "large");
  return {
    framebuffer,
    controls: buildWinControls(model),
    hotspots: [],
    scene: "win",
  };
}

function renderErrorScene(model: FirmwareModel): FirmwareFrame {
  const framebuffer = createFramebuffer(UI_COLORS.background);
  const controls = buildErrorControls(model);
  const lines = wrapText(
    model.error ?? "ERROR",
    SCREEN_WIDTH - 12,
    "large",
  ).slice(0, 6);

  clearFramebuffer(framebuffer, UI_COLORS.background);
  strokeRect(framebuffer, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, UI_COLORS.border);
  fillRect(framebuffer, 0, 0, SCREEN_WIDTH, 10, UI_COLORS.selection);
  drawText(framebuffer, 4, 1, "ERROR", UI_COLORS.textInverse, "large");

  lines.forEach((line, index) => {
    drawText(
      framebuffer,
      6,
      16 + index * getLineHeight("large"),
      line,
      UI_COLORS.text,
      "large",
    );
  });

  drawText(framebuffer, 6, 112, "HELP", UI_COLORS.textMuted, "large");
  drawText(framebuffer, 6, 121, "RESET", UI_COLORS.textMuted, "large");

  return {
    framebuffer,
    controls,
    hotspots: [],
    scene: "error",
  };
}

export function renderFirmware(model: FirmwareModel): FirmwareFrame {
  if (model.error) {
    return renderErrorScene(model);
  }

  if (model.scene === "help") {
    return renderHelpScene(model);
  }

  if (model.scene === "win") {
    return renderWinScene(model);
  }

  return renderGameplayScene(model);
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
