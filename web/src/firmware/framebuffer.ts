import { ARC_RGBA_PALETTE, UI_COLORS } from "./palette";
import type { Sprite } from "./sprites";

export const SCREEN_WIDTH = 128;
export const SCREEN_HEIGHT = 140;
export const GAMEPLAY_WIDTH = 128;
export const GAMEPLAY_HEIGHT = 128;
export const STATUS_BAR_HEIGHT = SCREEN_HEIGHT - GAMEPLAY_HEIGHT;
export const SOURCE_GRID_SIZE = 64;
export const GAMEPLAY_SCALE = GAMEPLAY_WIDTH / SOURCE_GRID_SIZE;

export type Framebuffer = Uint8Array;

export function createFramebuffer(
  fillColor: number = UI_COLORS.background,
): Framebuffer {
  return new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT).fill(fillColor);
}

export function clearFramebuffer(
  framebuffer: Framebuffer,
  color: number = UI_COLORS.background,
): void {
  framebuffer.fill(color);
}

export function setPixel(
  framebuffer: Framebuffer,
  x: number,
  y: number,
  color: number,
): void {
  if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= SCREEN_HEIGHT) {
    return;
  }

  framebuffer[y * SCREEN_WIDTH + x] = color;
}

export function fillRect(
  framebuffer: Framebuffer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
): void {
  const startX = Math.max(0, x);
  const startY = Math.max(0, y);
  const endX = Math.min(SCREEN_WIDTH, x + width);
  const endY = Math.min(SCREEN_HEIGHT, y + height);

  for (let row = startY; row < endY; row += 1) {
    const offset = row * SCREEN_WIDTH;
    for (let column = startX; column < endX; column += 1) {
      framebuffer[offset + column] = color;
    }
  }
}

export function strokeRect(
  framebuffer: Framebuffer,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
): void {
  for (let column = x; column < x + width; column += 1) {
    setPixel(framebuffer, column, y, color);
    setPixel(framebuffer, column, y + height - 1, color);
  }

  for (let row = y; row < y + height; row += 1) {
    setPixel(framebuffer, x, row, color);
    setPixel(framebuffer, x + width - 1, row, color);
  }
}

export function blitSprite(
  framebuffer: Framebuffer,
  sprite: Sprite,
  offsetX: number = 0,
  offsetY: number = 0,
  remap: Record<number, number> = {},
): void {
  const rows = sprite.height;
  const columns = sprite.width;

  if (rows === 0 || columns === 0) {
    return;
  }

  for (let y = 0; y < rows; y += 1) {
    const spriteRowOffset = y * columns;
    const framebufferRowOffset = (offsetY + y) * SCREEN_WIDTH + offsetX;
    for (let x = 0; x < columns; x += 1) {
      const sourceColor = sprite.data[spriteRowOffset + x] ?? 0;
      const color = remap[sourceColor] ?? sourceColor;
      if (color === 0) {
        continue;
      }
      framebuffer[framebufferRowOffset + x] = color;
    }
  }
}

export function blitArcGrid(
  framebuffer: Framebuffer,
  grid: number[][],
  offsetX: number = 0,
  offsetY: number = 0,
): void {
  const rows = grid.length;
  const columns = grid[0]?.length ?? 0;

  if (rows === 0 || columns === 0) {
    return;
  }

  for (let y = 0; y < rows; y += 1) {
    const row = grid[y] ?? [];
    for (let x = 0; x < columns; x += 1) {
      const color = row[x] ?? UI_COLORS.border;
      const left = offsetX + x * GAMEPLAY_SCALE;
      const top = offsetY + y * GAMEPLAY_SCALE;
      fillRect(framebuffer, left, top, GAMEPLAY_SCALE, GAMEPLAY_SCALE, color);
    }
  }
}

export function drawGridCursor(
  framebuffer: Framebuffer,
  cellX: number,
  cellY: number,
  color: number = UI_COLORS.warning,
  padding: number = 1,
): void {
  const left = cellX * GAMEPLAY_SCALE;
  const top = cellY * GAMEPLAY_SCALE;
  strokeRect(
    framebuffer,
    left - padding,
    top - padding,
    GAMEPLAY_SCALE + padding * 2,
    GAMEPLAY_SCALE + padding * 2,
    color,
  );
}

export function framebufferToImageData(framebuffer: Framebuffer): ImageData {
  const rgba = new Uint8ClampedArray(framebuffer.length * 4);

  for (let index = 0; index < framebuffer.length; index += 1) {
    const paletteIndex = framebuffer[index] ?? UI_COLORS.border;
    const [red, green, blue, alpha] =
      ARC_RGBA_PALETTE[paletteIndex] ?? ARC_RGBA_PALETTE[UI_COLORS.border];
    const rgbaIndex = index * 4;
    rgba[rgbaIndex] = red;
    rgba[rgbaIndex + 1] = green;
    rgba[rgbaIndex + 2] = blue;
    rgba[rgbaIndex + 3] = alpha;
  }

  return new ImageData(rgba, SCREEN_WIDTH, SCREEN_HEIGHT);
}
