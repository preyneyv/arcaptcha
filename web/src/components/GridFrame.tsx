import { useEffect, useRef, type PointerEvent } from "react";

const ARC_PALETTE = [
  "#111111",
  "#2f6fff",
  "#ef4e2c",
  "#24bb55",
  "#f0c630",
  "#858585",
  "#c24cf6",
  "#f18926",
  "#72d7ff",
  "#7a2e18",
  "#00a7a7",
  "#5a1f9b",
  "#7ce044",
  "#ff9ac8",
  "#cfd5de",
  "#f8f4ef",
];

interface GridFrameProps {
  grid: number[][];
  coordinateMode: boolean;
  onCellSelect: (x: number, y: number) => void;
}

interface RenderMetrics {
  cellSize: number;
  columns: number;
  gap: number;
  offsetX: number;
  offsetY: number;
  rows: number;
}

export function GridFrame({
  grid,
  coordinateMode,
  onCellSelect,
}: GridFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const metricsRef = useRef<RenderMetrics | null>(null);
  const rows = grid.length;
  const columns = grid[0]?.length ?? 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rows === 0 || columns === 0) {
      metricsRef.current = null;
      return;
    }

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      const bounds = canvas.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.floor(bounds.width));
      const cssHeight = Math.max(1, Math.floor(bounds.height));
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      const gap = columns > 18 || rows > 18 ? 0 : 1;
      const cellSize = Math.max(
        1,
        Math.floor(
          Math.min(
            (cssWidth - gap * Math.max(columns - 1, 0)) / columns,
            (cssHeight - gap * Math.max(rows - 1, 0)) / rows,
          ),
        ),
      );
      const boardWidth = cellSize * columns + gap * Math.max(columns - 1, 0);
      const boardHeight = cellSize * rows + gap * Math.max(rows - 1, 0);
      const offsetX = Math.floor((cssWidth - boardWidth) / 2);
      const offsetY = Math.floor((cssHeight - boardHeight) / 2);

      metricsRef.current = {
        cellSize,
        columns,
        gap,
        offsetX,
        offsetY,
        rows,
      };

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.imageSmoothingEnabled = false;

      const background = context.createLinearGradient(0, 0, 0, cssHeight);
      background.addColorStop(0, "#18281e");
      background.addColorStop(1, "#101b15");
      context.fillStyle = background;
      context.fillRect(0, 0, cssWidth, cssHeight);

      context.fillStyle = "#0b130f";
      context.fillRect(
        Math.max(0, offsetX - 10),
        Math.max(0, offsetY - 10),
        boardWidth + 20,
        boardHeight + 20,
      );

      grid.forEach((row, y) => {
        row.forEach((value, x) => {
          const left = offsetX + x * (cellSize + gap);
          const top = offsetY + y * (cellSize + gap);

          context.fillStyle = ARC_PALETTE[value] ?? ARC_PALETTE[0];
          context.fillRect(left, top, cellSize, cellSize);
        });
      });

      if (coordinateMode) {
        context.strokeStyle = "rgba(136, 255, 118, 0.58)";
        context.lineWidth = 4;
        context.strokeRect(
          Math.max(2, offsetX - 6),
          Math.max(2, offsetY - 6),
          boardWidth + 12,
          boardHeight + 12,
        );
      }

      context.fillStyle = "rgba(255, 255, 255, 0.035)";
      for (let y = 0; y < cssHeight; y += 4) {
        context.fillRect(0, y, cssWidth, 1);
      }
    };

    draw();

    const host = canvas.parentElement;
    if (!host || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => draw());
    observer.observe(host);
    return () => observer.disconnect();
  }, [columns, coordinateMode, grid, rows]);

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!coordinateMode) {
      return;
    }

    const metrics = metricsRef.current;
    if (!metrics) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const step = metrics.cellSize + metrics.gap;
    const x = Math.floor((localX - metrics.offsetX) / step);
    const y = Math.floor((localY - metrics.offsetY) / step);

    if (x < 0 || x >= metrics.columns || y < 0 || y >= metrics.rows) {
      return;
    }

    const cellLeft = metrics.offsetX + x * step;
    const cellTop = metrics.offsetY + y * step;
    if (
      localX > cellLeft + metrics.cellSize ||
      localY > cellTop + metrics.cellSize
    ) {
      return;
    }

    onCellSelect(x, y);
  };

  if (rows === 0 || columns === 0) {
    return (
      <div className="grid-empty-state">
        <span>BOOT</span>
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <div
        className="grid-canvas-shell"
        data-coordinate-mode={coordinateMode}
        style={{
          aspectRatio: `${columns} / ${rows}`,
          height: columns < rows ? "100%" : undefined,
          maxHeight: "100%",
          maxWidth: "100%",
          width: columns >= rows ? "100%" : undefined,
        }}
      >
        <canvas
          ref={canvasRef}
          className="grid-canvas"
          onPointerDown={handlePointerDown}
        />
      </div>
    </div>
  );
}
