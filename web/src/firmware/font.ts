import { type Framebuffer, setPixel } from "./framebuffer";

type SmallGlyph = readonly [string, string, string, string, string];
type LargeGlyph = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export type FontSize = "small" | "large";

const SMALL_METRICS = {
  width: 3,
  height: 5,
  spacing: 1,
  lineHeight: 6,
} as const;

const LARGE_METRICS = {
  width: 5,
  height: 7,
  spacing: 1,
  lineHeight: 9,
} as const;

const SMALL_EMPTY: SmallGlyph = ["000", "000", "000", "000", "000"];
const LARGE_EMPTY: LargeGlyph = [
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
  "00000",
];

const SMALL_GLYPHS: Record<string, SmallGlyph> = {
  " ": SMALL_EMPTY,
  "!": ["010", "010", "010", "000", "010"],
  "#": ["101", "111", "101", "111", "101"],
  "+": ["000", "010", "111", "010", "000"],
  ",": ["000", "000", "000", "010", "100"],
  "-": ["000", "000", "111", "000", "000"],
  ".": ["000", "000", "000", "000", "010"],
  "/": ["001", "001", "010", "100", "100"],
  ":": ["000", "010", "000", "010", "000"],
  "?": ["110", "001", "010", "000", "010"],
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["110", "001", "010", "100", "111"],
  "3": ["110", "001", "010", "001", "110"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "110", "001", "110"],
  "6": ["011", "100", "110", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "110"],
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["011", "100", "100", "100", "011"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  G: ["011", "100", "101", "101", "011"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  J: ["001", "001", "001", "101", "010"],
  K: ["101", "101", "110", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "111", "101", "101"],
  N: ["101", "111", "111", "111", "101"],
  O: ["111", "101", "101", "101", "111"],
  P: ["110", "101", "110", "100", "100"],
  Q: ["111", "101", "101", "111", "001"],
  R: ["110", "101", "110", "101", "101"],
  S: ["011", "100", "111", "001", "110"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  V: ["101", "101", "101", "101", "010"],
  W: ["101", "101", "111", "111", "101"],
  X: ["101", "101", "010", "101", "101"],
  Y: ["101", "101", "010", "010", "010"],
  Z: ["111", "001", "010", "100", "111"],
};

const LARGE_GLYPHS: Record<string, LargeGlyph> = {
  " ": LARGE_EMPTY,
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "-": ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  "?": ["01110", "10001", "00010", "00100", "00100", "00000", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00001", "00001", "00001", "00001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10001", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10001", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function getMetrics(size: FontSize) {
  return size === "small" ? SMALL_METRICS : LARGE_METRICS;
}

function getGlyph(character: string, size: FontSize): readonly string[] {
  if (size === "small") {
    return (
      SMALL_GLYPHS[character] ??
      SMALL_GLYPHS[character.toUpperCase()] ??
      SMALL_EMPTY
    );
  }

  return (
    LARGE_GLYPHS[character] ??
    LARGE_GLYPHS[character.toUpperCase()] ??
    LARGE_EMPTY
  );
}

export function getLineHeight(size: FontSize = "large"): number {
  return getMetrics(size).lineHeight;
}

export function measureText(text: string, size: FontSize = "large"): number {
  if (!text) {
    return 0;
  }

  const metrics = getMetrics(size);
  return text.length * (metrics.width + metrics.spacing) - metrics.spacing;
}

export function drawText(
  framebuffer: Framebuffer,
  x: number,
  y: number,
  text: string,
  color: number,
  size: FontSize = "large",
): void {
  const metrics = getMetrics(size);
  let cursorX = x;

  for (const character of text.toUpperCase()) {
    const glyph = getGlyph(character, size);
    for (let row = 0; row < glyph.length; row += 1) {
      const bits = glyph[row];
      for (let column = 0; column < bits.length; column += 1) {
        if (bits[column] === "1") {
          setPixel(framebuffer, cursorX + column, y + row, color);
        }
      }
    }
    cursorX += metrics.width + metrics.spacing;
  }
}

export function drawTextRight(
  framebuffer: Framebuffer,
  right: number,
  y: number,
  text: string,
  color: number,
  size: FontSize = "large",
): void {
  drawText(framebuffer, right - measureText(text, size), y, text, color, size);
}

export function drawTextCenter(
  framebuffer: Framebuffer,
  x: number,
  y: number,
  text: string,
  color: number,
  size: FontSize = "large",
): void {
  drawText(
    framebuffer,
    x - Math.floor(measureText(text, size) / 2),
    y,
    text,
    color,
    size,
  );
}

export function wrapText(
  text: string,
  maxWidth: number,
  size: FontSize = "large",
): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureText(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
    }
    current = word;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}
