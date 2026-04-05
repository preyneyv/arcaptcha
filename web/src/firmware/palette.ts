export const ARC_COLOR_MAP = {
  0: "#FFFFFFFF",
  1: "#CCCCCCFF",
  2: "#999999FF",
  3: "#666666FF",
  4: "#333333FF",
  5: "#000000FF",
  6: "#E53AA3FF",
  7: "#FF7BCCFF",
  8: "#F93C31FF",
  9: "#1E93FFFF",
  10: "#88D8F1FF",
  11: "#FFDC00FF",
  12: "#FF851BFF",
  13: "#921231FF",
  14: "#4FCC30FF",
  15: "#A356D6FF",
} as const;

export const ARC_RGBA_PALETTE = Object.values(ARC_COLOR_MAP).map((hex) => {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    Number.parseInt(normalized.slice(6, 8), 16),
  ] as const;
});

export const UI_COLORS = {
  background: 5,
  backgroundStrong: 5,
  border: 3,
  text: 0,
  textMuted: 2,
  textInverse: 0,
  accent: 0,
  accentAlt: 1,
  warning: 0,
  error: 0,
  selection: 4,
} as const;
