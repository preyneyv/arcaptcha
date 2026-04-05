import { useEffect, useRef } from "react";

const BACKGROUND_HEX = "#0B0B0B";
const LIFE_HEX = "#1A1A1A";
const BACKGROUND_SHADER_RGB = "vec3(0.043137255, 0.043137255, 0.043137255)";
const LIFE_SHADER_RGB = "vec3(0.101960784, 0.101960784, 0.101960784)";
const CELL_SCALE = 4;
const OVERSCAN_CELLS = 100;
const INITIAL_DENSITY = 0.08;
const MIN_POINTER_SPAWN_RADIUS = 1;
const POINTER_SPAWN_RADIUS = 3;
const POINTER_SPEED_FOR_THICK = 0.08;
const POINTER_SPEED_FOR_THIN = 1.4;
const POINTER_STROKE_SPACING = CELL_SCALE * 0.75;
const SIMULATION_STEP_MS = 1000 / 10;
const INITIAL_WARMUP_STEPS = 8;

const FULLSCREEN_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const LIFE_STEP_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
precision mediump sampler2D;

uniform sampler2D uState;
uniform ivec2 uStateSize;

out vec4 outColor;

int readCell(ivec2 coordinate) {
  ivec2 wrapped = ivec2(
    (coordinate.x % uStateSize.x + uStateSize.x) % uStateSize.x,
    (coordinate.y % uStateSize.y + uStateSize.y) % uStateSize.y
  );
  return texelFetch(uState, wrapped, 0).r > 0.5 ? 1 : 0;
}

void main() {
  ivec2 coordinate = ivec2(gl_FragCoord.xy);
  int neighbors =
    readCell(coordinate + ivec2(-1, -1)) +
    readCell(coordinate + ivec2(0, -1)) +
    readCell(coordinate + ivec2(1, -1)) +
    readCell(coordinate + ivec2(-1, 0)) +
    readCell(coordinate + ivec2(1, 0)) +
    readCell(coordinate + ivec2(-1, 1)) +
    readCell(coordinate + ivec2(0, 1)) +
    readCell(coordinate + ivec2(1, 1));
  int alive = readCell(coordinate);
  int nextAlive = neighbors == 3 || (alive == 1 && neighbors == 2) ? 1 : 0;

  float value = float(nextAlive);
  outColor = vec4(value, value, value, 1.0);
}
`;

const LIFE_RENDER_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
precision mediump sampler2D;

uniform sampler2D uState;
uniform ivec2 uVisibleSize;
uniform ivec2 uCropOrigin;
uniform vec2 uCanvasSize;

out vec4 outColor;

void main() {
  vec2 normalized = vec2(
    gl_FragCoord.x / uCanvasSize.x,
    1.0 - (gl_FragCoord.y / uCanvasSize.y)
  );
  vec2 scaled = vec2(
    normalized.x * float(uVisibleSize.x),
    normalized.y * float(uVisibleSize.y)
  );
  ivec2 visibleCoordinate = ivec2(min(floor(scaled), vec2(uVisibleSize - 1)));
  ivec2 stateCoordinate = uCropOrigin + visibleCoordinate;

  float alive = texelFetch(uState, stateCoordinate, 0).r;
  vec3 background = ${BACKGROUND_SHADER_RGB};
  vec3 life = ${LIFE_SHADER_RGB};
  vec3 color = mix(background, life, alive);
  outColor = vec4(color, 1.0);
}
`;

interface ViewportMetrics {
  canvasHeight: number;
  canvasWidth: number;
  cropX: number;
  cropY: number;
  cssHeight: number;
  cssWidth: number;
  dpr: number;
  totalColumns: number;
  totalRows: number;
  visibleColumns: number;
  visibleRows: number;
}

interface Renderer {
  dispose: () => void;
  injectAtViewportPoint: (
    bounds: DOMRect,
    clientX: number,
    clientY: number,
    radius?: number,
  ) => void;
  injectViewportSegment: (
    bounds: DOMRect,
    startClientX: number,
    startClientY: number,
    endClientX: number,
    endClientY: number,
    radius?: number,
  ) => void;
  render: () => void;
  resize: (metrics: ViewportMetrics) => void;
  step: () => void;
}

interface SimulationCell {
  column: number;
  row: number;
}

interface PointerSample {
  timestamp: number;
  x: number;
  y: number;
}

function createPointerSample(
  clientX: number,
  clientY: number,
  timestamp: number,
): PointerSample {
  return {
    timestamp,
    x: clientX,
    y: clientY,
  };
}

function findTouchByIdentifier(
  touches: TouchList,
  identifier: number,
): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch && touch.identifier === identifier) {
      return touch;
    }
  }

  return null;
}

function getPointerSpawnRadius(
  startPoint: PointerSample,
  endPoint: PointerSample,
): number {
  const elapsedMs = Math.max(1, endPoint.timestamp - startPoint.timestamp);
  const distance = Math.hypot(
    endPoint.x - startPoint.x,
    endPoint.y - startPoint.y,
  );
  const speed = distance / elapsedMs;
  const speedProgress = clamp(
    (speed - POINTER_SPEED_FOR_THICK) /
      (POINTER_SPEED_FOR_THIN - POINTER_SPEED_FOR_THICK),
    0,
    1,
  );

  return Math.round(
    POINTER_SPAWN_RADIUS -
      speedProgress * (POINTER_SPAWN_RADIUS - MIN_POINTER_SPAWN_RADIUS),
  );
}

function forEachClusterCell(
  columns: number,
  rows: number,
  centerColumn: number,
  centerRow: number,
  radius: number,
  visit: (column: number, row: number) => void,
) {
  for (let row = centerRow - radius; row <= centerRow + radius; row += 1) {
    if (row < 0 || row >= rows) {
      continue;
    }

    for (
      let column = centerColumn - radius;
      column <= centerColumn + radius;
      column += 1
    ) {
      if (column < 0 || column >= columns) {
        continue;
      }

      const deltaX = column - centerColumn;
      const deltaY = row - centerRow;
      if (deltaX * deltaX + deltaY * deltaY > radius * radius) {
        continue;
      }

      visit(column, row);
    }
  }
}

function forEachViewportSegmentPoint(
  startClientX: number,
  startClientY: number,
  endClientX: number,
  endClientY: number,
  visit: (clientX: number, clientY: number) => void,
) {
  const deltaX = endClientX - startClientX;
  const deltaY = endClientY - startClientY;
  const distance = Math.hypot(deltaX, deltaY);
  const steps = Math.max(1, Math.ceil(distance / POINTER_STROKE_SPACING));

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    visit(startClientX + deltaX * progress, startClientY + deltaY * progress);
  }
}

function deriveViewportMetrics(
  width: number,
  height: number,
  dpr: number,
): ViewportMetrics {
  const cssWidth = Math.max(1, Math.floor(width));
  const cssHeight = Math.max(1, Math.floor(height));
  const visibleColumns = Math.max(1, Math.ceil(cssWidth / CELL_SCALE));
  const visibleRows = Math.max(1, Math.ceil(cssHeight / CELL_SCALE));

  return {
    canvasHeight: Math.max(1, Math.floor(cssHeight * dpr)),
    canvasWidth: Math.max(1, Math.floor(cssWidth * dpr)),
    cropX: OVERSCAN_CELLS,
    cropY: OVERSCAN_CELLS,
    cssHeight,
    cssWidth,
    dpr,
    totalColumns: visibleColumns + OVERSCAN_CELLS * 2,
    totalRows: visibleRows + OVERSCAN_CELLS * 2,
    visibleColumns,
    visibleRows,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function viewportPointToSimulationCell(
  metrics: ViewportMetrics,
  bounds: DOMRect,
  clientX: number,
  clientY: number,
): SimulationCell {
  const normalizedX = clamp(
    (clientX - bounds.left) / bounds.width,
    0,
    0.999999,
  );
  const normalizedY = clamp(
    (clientY - bounds.top) / bounds.height,
    0,
    0.999999,
  );

  return {
    column:
      metrics.cropX +
      Math.min(
        metrics.visibleColumns - 1,
        Math.floor(normalizedX * metrics.visibleColumns),
      ),
    row:
      metrics.cropY +
      Math.min(
        metrics.visibleRows - 1,
        Math.floor(normalizedY * metrics.visibleRows),
      ),
  };
}

function createSeededState(columns: number, rows: number): Uint8Array {
  const state = new Uint8Array(columns * rows);

  for (let index = 0; index < state.length; index += 1) {
    state[index] = Math.random() < INITIAL_DENSITY ? 1 : 0;
  }

  return state;
}

function stepStateCPU(
  current: Uint8Array,
  next: Uint8Array,
  columns: number,
  rows: number,
) {
  for (let row = 0; row < rows; row += 1) {
    const north = row === 0 ? rows - 1 : row - 1;
    const south = row === rows - 1 ? 0 : row + 1;

    for (let column = 0; column < columns; column += 1) {
      const west = column === 0 ? columns - 1 : column - 1;
      const east = column === columns - 1 ? 0 : column + 1;
      const index = row * columns + column;
      const neighbors =
        current[north * columns + west] +
        current[north * columns + column] +
        current[north * columns + east] +
        current[row * columns + west] +
        current[row * columns + east] +
        current[south * columns + west] +
        current[south * columns + column] +
        current[south * columns + east];

      next[index] =
        neighbors === 3 || (current[index] === 1 && neighbors === 2) ? 1 : 0;
    }
  }
}

function warmState(
  state: Uint8Array,
  columns: number,
  rows: number,
  steps: number,
) {
  let current: Uint8Array<ArrayBufferLike> = state;
  let next: Uint8Array<ArrayBufferLike> = new Uint8Array(columns * rows);

  for (let step = 0; step < steps; step += 1) {
    stepStateCPU(current, next, columns, rows);
    [current, next] = [next, current];
  }

  if (current !== state) {
    state.set(current);
  }
}

function copyCenteredState(
  source: Uint8Array,
  sourceColumns: number,
  sourceRows: number,
  target: Uint8Array,
  targetColumns: number,
  targetRows: number,
) {
  const copyColumns = Math.min(sourceColumns, targetColumns);
  const copyRows = Math.min(sourceRows, targetRows);
  const sourceOffsetX = Math.floor((sourceColumns - copyColumns) / 2);
  const sourceOffsetY = Math.floor((sourceRows - copyRows) / 2);
  const targetOffsetX = Math.floor((targetColumns - copyColumns) / 2);
  const targetOffsetY = Math.floor((targetRows - copyRows) / 2);

  for (let row = 0; row < copyRows; row += 1) {
    const sourceStart = (sourceOffsetY + row) * sourceColumns + sourceOffsetX;
    const targetStart = (targetOffsetY + row) * targetColumns + targetOffsetX;

    target.set(
      source.subarray(sourceStart, sourceStart + copyColumns),
      targetStart,
    );
  }
}

function paintCluster(
  state: Uint8Array,
  columns: number,
  rows: number,
  centerColumn: number,
  centerRow: number,
  radius: number,
) {
  forEachClusterCell(
    columns,
    rows,
    centerColumn,
    centerRow,
    radius,
    (column, row) => {
      state[row * columns + column] = 1;
    },
  );
}

function createResizedState(
  nextColumns: number,
  nextRows: number,
  previousState?: Uint8Array,
  previousColumns?: number,
  previousRows?: number,
): Uint8Array {
  const nextState = createSeededState(nextColumns, nextRows);

  if (
    previousState &&
    previousColumns !== undefined &&
    previousRows !== undefined
  ) {
    copyCenteredState(
      previousState,
      previousColumns,
      previousRows,
      nextState,
      nextColumns,
      nextRows,
    );
    return nextState;
  }

  warmState(nextState, nextColumns, nextRows, INITIAL_WARMUP_STEPS);
  return nextState;
}

function expandStateToRgba(state: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(state.length * 4);

  for (let index = 0; index < state.length; index += 1) {
    const value = state[index] === 1 ? 255 : 0;
    const offset = index * 4;

    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }

  return rgba;
}

function compactStateFromRgba(pixels: Uint8Array): Uint8Array {
  const state = new Uint8Array(pixels.length / 4);

  for (let index = 0; index < state.length; index += 1) {
    state[index] = pixels[index * 4] > 127 ? 1 : 0;
  }

  return state;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);

  if (!shader) {
    throw new Error("Unable to allocate shader.");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const infoLog =
      gl.getShaderInfoLog(shader) ?? "Unknown shader compile error.";
    gl.deleteShader(shader);
    throw new Error(infoLog);
  }

  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram();

  if (!program) {
    throw new Error("Unable to allocate WebGL program.");
  }

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const infoLog =
      gl.getProgramInfoLog(program) ?? "Unknown program link error.";
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error(infoLog);
  }

  gl.detachShader(program, vertexShader);
  gl.detachShader(program, fragmentShader);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  return program;
}

function createFullscreenVao(
  gl: WebGL2RenderingContext,
): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();

  if (!vao || !buffer) {
    throw new Error("Unable to allocate fullscreen geometry.");
  }

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return vao;
}

function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Uint8Array,
): WebGLTexture {
  const texture = gl.createTexture();

  if (!texture) {
    throw new Error("Unable to allocate simulation texture.");
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data,
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function createFramebuffer(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): WebGLFramebuffer {
  const framebuffer = gl.createFramebuffer();

  if (!framebuffer) {
    throw new Error("Unable to allocate framebuffer.");
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
  );

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    throw new Error("Simulation framebuffer is incomplete.");
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return framebuffer;
}

function createWebGLRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    desynchronized: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: false,
    stencil: false,
  });

  if (!gl) {
    return null;
  }

  const stepProgram = createProgram(
    gl,
    FULLSCREEN_VERTEX_SHADER,
    LIFE_STEP_FRAGMENT_SHADER,
  );
  const renderProgram = createProgram(
    gl,
    FULLSCREEN_VERTEX_SHADER,
    LIFE_RENDER_FRAGMENT_SHADER,
  );
  const vao = createFullscreenVao(gl);
  const stepStateSizeLocation = gl.getUniformLocation(
    stepProgram,
    "uStateSize",
  );
  const renderVisibleSizeLocation = gl.getUniformLocation(
    renderProgram,
    "uVisibleSize",
  );
  const renderCropOriginLocation = gl.getUniformLocation(
    renderProgram,
    "uCropOrigin",
  );
  const renderCanvasSizeLocation = gl.getUniformLocation(
    renderProgram,
    "uCanvasSize",
  );

  if (
    !stepStateSizeLocation ||
    !renderVisibleSizeLocation ||
    !renderCropOriginLocation ||
    !renderCanvasSizeLocation
  ) {
    throw new Error("Missing Conway shader uniform locations.");
  }

  gl.useProgram(stepProgram);
  gl.uniform1i(gl.getUniformLocation(stepProgram, "uState"), 0);
  gl.useProgram(renderProgram);
  gl.uniform1i(gl.getUniformLocation(renderProgram, "uState"), 0);
  gl.useProgram(null);

  let currentMetrics = deriveViewportMetrics(1, 1, 1);
  let currentTexture: WebGLTexture | null = null;
  let nextTexture: WebGLTexture | null = null;
  let currentFramebuffer: WebGLFramebuffer | null = null;
  let nextFramebuffer: WebGLFramebuffer | null = null;

  const readCurrentState = (metrics: ViewportMetrics) => {
    if (!currentFramebuffer) {
      return undefined;
    }

    const pixels = new Uint8Array(metrics.totalColumns * metrics.totalRows * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, currentFramebuffer);
    gl.readPixels(
      0,
      0,
      metrics.totalColumns,
      metrics.totalRows,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return compactStateFromRgba(pixels);
  };

  const destroyBuffers = () => {
    if (currentFramebuffer) {
      gl.deleteFramebuffer(currentFramebuffer);
      currentFramebuffer = null;
    }

    if (nextFramebuffer) {
      gl.deleteFramebuffer(nextFramebuffer);
      nextFramebuffer = null;
    }

    if (currentTexture) {
      gl.deleteTexture(currentTexture);
      currentTexture = null;
    }

    if (nextTexture) {
      gl.deleteTexture(nextTexture);
      nextTexture = null;
    }
  };

  const injectAliveCluster = (
    centerColumn: number,
    centerRow: number,
    radius: number,
  ) => {
    if (!currentFramebuffer || !nextFramebuffer) {
      return;
    }

    const previousClearColor = gl.getParameter(
      gl.COLOR_CLEAR_VALUE,
    ) as Float32Array;
    gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(1, 1, 1, 1);

    for (const framebuffer of [currentFramebuffer, nextFramebuffer]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      forEachClusterCell(
        currentMetrics.totalColumns,
        currentMetrics.totalRows,
        centerColumn,
        centerRow,
        radius,
        (column, row) => {
          gl.scissor(column, row, 1, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        },
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(
      previousClearColor[0],
      previousClearColor[1],
      previousClearColor[2],
      previousClearColor[3],
    );
  };

  const allocateState = (
    metrics: ViewportMetrics,
    previousMetrics: ViewportMetrics,
  ) => {
    const previousState = currentTexture
      ? readCurrentState(previousMetrics)
      : undefined;
    const nextState = createResizedState(
      metrics.totalColumns,
      metrics.totalRows,
      previousState,
      currentTexture ? previousMetrics.totalColumns : undefined,
      currentTexture ? previousMetrics.totalRows : undefined,
    );

    destroyBuffers();

    const rgba = expandStateToRgba(nextState);
    currentTexture = createTexture(
      gl,
      metrics.totalColumns,
      metrics.totalRows,
      rgba,
    );
    nextTexture = createTexture(
      gl,
      metrics.totalColumns,
      metrics.totalRows,
      rgba,
    );
    currentFramebuffer = createFramebuffer(gl, currentTexture);
    nextFramebuffer = createFramebuffer(gl, nextTexture);
  };

  const render = () => {
    if (!currentTexture) {
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, currentMetrics.canvasWidth, currentMetrics.canvasHeight);
    gl.useProgram(renderProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.uniform2i(
      renderVisibleSizeLocation,
      currentMetrics.visibleColumns,
      currentMetrics.visibleRows,
    );
    gl.uniform2i(
      renderCropOriginLocation,
      currentMetrics.cropX,
      currentMetrics.cropY,
    );
    gl.uniform2f(
      renderCanvasSizeLocation,
      currentMetrics.canvasWidth,
      currentMetrics.canvasHeight,
    );
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  };

  const step = () => {
    if (!currentTexture || !nextFramebuffer || !nextTexture) {
      return;
    }

    gl.viewport(0, 0, currentMetrics.totalColumns, currentMetrics.totalRows);
    gl.bindFramebuffer(gl.FRAMEBUFFER, nextFramebuffer);
    gl.useProgram(stepProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    gl.uniform2i(
      stepStateSizeLocation,
      currentMetrics.totalColumns,
      currentMetrics.totalRows,
    );
    gl.bindVertexArray(vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(null);

    [currentTexture, nextTexture] = [nextTexture, currentTexture];
    [currentFramebuffer, nextFramebuffer] = [
      nextFramebuffer,
      currentFramebuffer,
    ];
    render();
  };

  const resize = (metrics: ViewportMetrics) => {
    const previousMetrics = currentMetrics;

    if (
      canvas.width !== metrics.canvasWidth ||
      canvas.height !== metrics.canvasHeight
    ) {
      canvas.width = metrics.canvasWidth;
      canvas.height = metrics.canvasHeight;
    }

    const needsGridResize =
      !currentTexture ||
      metrics.totalColumns !== previousMetrics.totalColumns ||
      metrics.totalRows !== previousMetrics.totalRows;

    if (needsGridResize) {
      allocateState(metrics, previousMetrics);
    }

    currentMetrics = metrics;

    render();
  };

  const injectViewportSegment = (
    bounds: DOMRect,
    startClientX: number,
    startClientY: number,
    endClientX: number,
    endClientY: number,
    radius = POINTER_SPAWN_RADIUS,
  ) => {
    if (!currentTexture) {
      return;
    }

    forEachViewportSegmentPoint(
      startClientX,
      startClientY,
      endClientX,
      endClientY,
      (clientX, clientY) => {
        const cell = viewportPointToSimulationCell(
          currentMetrics,
          bounds,
          clientX,
          clientY,
        );

        injectAliveCluster(cell.column, cell.row, radius);
      },
    );

    render();
  };

  const injectAtViewportPoint = (
    bounds: DOMRect,
    clientX: number,
    clientY: number,
    radius = POINTER_SPAWN_RADIUS,
  ) => {
    injectViewportSegment(bounds, clientX, clientY, clientX, clientY, radius);
  };

  return {
    dispose: () => {
      destroyBuffers();
      gl.deleteProgram(stepProgram);
      gl.deleteProgram(renderProgram);
      gl.deleteVertexArray(vao);
    },
    injectAtViewportPoint,
    injectViewportSegment,
    render,
    resize,
    step,
  };
}

function createCanvasRenderer(canvas: HTMLCanvasElement): Renderer {
  const context = canvas.getContext("2d", {
    alpha: true,
    desynchronized: true,
  });

  if (!context) {
    throw new Error("Unable to allocate 2D fallback renderer.");
  }

  const offscreenCanvas = document.createElement("canvas");
  const offscreenContext = offscreenCanvas.getContext("2d", { alpha: true });

  if (!offscreenContext) {
    throw new Error("Unable to allocate 2D fallback surface.");
  }

  let currentMetrics = deriveViewportMetrics(1, 1, 1);
  let currentState: Uint8Array<ArrayBufferLike> = new Uint8Array(1);
  let nextState: Uint8Array<ArrayBufferLike> = new Uint8Array(1);

  const drawBackground = () => {
    context.setTransform(currentMetrics.dpr, 0, 0, currentMetrics.dpr, 0, 0);
    context.clearRect(0, 0, currentMetrics.cssWidth, currentMetrics.cssHeight);
    context.fillStyle = BACKGROUND_HEX;
    context.fillRect(0, 0, currentMetrics.cssWidth, currentMetrics.cssHeight);
  };

  const render = () => {
    drawBackground();

    const imageData = offscreenContext.createImageData(
      currentMetrics.visibleColumns,
      currentMetrics.visibleRows,
    );
    const data = imageData.data;

    for (let row = 0; row < currentMetrics.visibleRows; row += 1) {
      for (
        let column = 0;
        column < currentMetrics.visibleColumns;
        column += 1
      ) {
        const stateIndex =
          (currentMetrics.cropY + row) * currentMetrics.totalColumns +
          currentMetrics.cropX +
          column;

        if (currentState[stateIndex] === 0) {
          continue;
        }

        const pixelIndex = (row * currentMetrics.visibleColumns + column) * 4;

        data[pixelIndex] = 0x1a;
        data[pixelIndex + 1] = 0x1a;
        data[pixelIndex + 2] = 0x1a;
        data[pixelIndex + 3] = 255;
      }
    }

    offscreenContext.putImageData(imageData, 0, 0);
    context.save();
    context.imageSmoothingEnabled = false;
    context.drawImage(
      offscreenCanvas,
      0,
      0,
      currentMetrics.visibleColumns,
      currentMetrics.visibleRows,
      0,
      0,
      currentMetrics.cssWidth,
      currentMetrics.cssHeight,
    );
    context.restore();
  };

  const resize = (metrics: ViewportMetrics) => {
    const previousState = currentState.length > 1 ? currentState : undefined;
    const previousColumns =
      currentState.length > 1 ? currentMetrics.totalColumns : undefined;
    const previousRows =
      currentState.length > 1 ? currentMetrics.totalRows : undefined;

    currentMetrics = metrics;
    canvas.width = metrics.canvasWidth;
    canvas.height = metrics.canvasHeight;
    canvas.style.width = `${metrics.cssWidth}px`;
    canvas.style.height = `${metrics.cssHeight}px`;
    context.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    offscreenCanvas.width = metrics.visibleColumns;
    offscreenCanvas.height = metrics.visibleRows;
    currentState = createResizedState(
      metrics.totalColumns,
      metrics.totalRows,
      previousState,
      previousColumns,
      previousRows,
    );
    nextState = new Uint8Array(metrics.totalColumns * metrics.totalRows);
    render();
  };

  const injectViewportSegment = (
    bounds: DOMRect,
    startClientX: number,
    startClientY: number,
    endClientX: number,
    endClientY: number,
    radius = POINTER_SPAWN_RADIUS,
  ) => {
    forEachViewportSegmentPoint(
      startClientX,
      startClientY,
      endClientX,
      endClientY,
      (clientX, clientY) => {
        const cell = viewportPointToSimulationCell(
          currentMetrics,
          bounds,
          clientX,
          clientY,
        );

        paintCluster(
          currentState,
          currentMetrics.totalColumns,
          currentMetrics.totalRows,
          cell.column,
          cell.row,
          radius,
        );
      },
    );

    render();
  };

  const injectAtViewportPoint = (
    bounds: DOMRect,
    clientX: number,
    clientY: number,
    radius = POINTER_SPAWN_RADIUS,
  ) => {
    injectViewportSegment(bounds, clientX, clientY, clientX, clientY, radius);
  };

  const step = () => {
    stepStateCPU(
      currentState,
      nextState,
      currentMetrics.totalColumns,
      currentMetrics.totalRows,
    );
    [currentState, nextState] = [nextState, currentState];
    render();
  };

  return {
    dispose: () => {
      context.setTransform(1, 0, 0, 1, 0, 0);
    },
    injectAtViewportPoint,
    injectViewportSegment,
    render,
    resize,
    step,
  };
}

export function ConwayBackground() {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;

    if (!host || !canvas) {
      return;
    }

    let renderer: Renderer;

    try {
      renderer = createWebGLRenderer(canvas) ?? createCanvasRenderer(canvas);
    } catch {
      renderer = createCanvasRenderer(canvas);
    }

    let lastFrameTime = 0;
    let accumulator = 0;
    let activeTouchId: number | null = null;
    let animationFrameId = 0;
    let lastInjectedPointer: PointerSample | null = null;
    let pendingPointerTarget: PointerSample | null = null;

    const syncViewport = () => {
      const bounds = host.getBoundingClientRect();
      const metrics = deriveViewportMetrics(
        bounds.width,
        bounds.height,
        window.devicePixelRatio || 1,
      );
      renderer.resize(metrics);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }

      pendingPointerTarget = createPointerSample(
        event.clientX,
        event.clientY,
        event.timeStamp,
      );
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (activeTouchId !== null) {
        return;
      }

      const touch = event.changedTouches[0] ?? event.touches[0];
      if (!touch) {
        return;
      }

      activeTouchId = touch.identifier;
      pendingPointerTarget = createPointerSample(
        touch.clientX,
        touch.clientY,
        event.timeStamp,
      );
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch =
        activeTouchId === null
          ? (event.touches[0] ?? event.changedTouches[0])
          : (findTouchByIdentifier(event.touches, activeTouchId) ??
            findTouchByIdentifier(event.changedTouches, activeTouchId));

      if (!touch) {
        return;
      }

      if (activeTouchId === null) {
        activeTouchId = touch.identifier;
      }

      pendingPointerTarget = createPointerSample(
        touch.clientX,
        touch.clientY,
        event.timeStamp,
      );
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (activeTouchId === null) {
        return;
      }

      if (findTouchByIdentifier(event.changedTouches, activeTouchId)) {
        resetPointerStroke();
      }
    };

    const resetPointerStroke = () => {
      activeTouchId = null;
      lastInjectedPointer = null;
      pendingPointerTarget = null;
    };

    const handleWindowMouseOut = (event: MouseEvent) => {
      if (event.relatedTarget === null) {
        resetPointerStroke();
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        resetPointerStroke();
      }
    };

    const tick = (timestamp: number) => {
      if (lastFrameTime === 0) {
        lastFrameTime = timestamp;
      }

      const elapsed = Math.min(64, timestamp - lastFrameTime);
      lastFrameTime = timestamp;

      if (!document.hidden) {
        if (pendingPointerTarget) {
          const startPoint = lastInjectedPointer ?? pendingPointerTarget;
          const spawnRadius = getPointerSpawnRadius(
            startPoint,
            pendingPointerTarget,
          );

          renderer.injectViewportSegment(
            host.getBoundingClientRect(),
            startPoint.x,
            startPoint.y,
            pendingPointerTarget.x,
            pendingPointerTarget.y,
            spawnRadius,
          );
          lastInjectedPointer = pendingPointerTarget;
          pendingPointerTarget = null;
        }

        accumulator += elapsed;

        while (accumulator >= SIMULATION_STEP_MS) {
          renderer.step();
          accumulator -= SIMULATION_STEP_MS;
        }
      }

      animationFrameId = window.requestAnimationFrame(tick);
    };

    syncViewport();
    animationFrameId = window.requestAnimationFrame(tick);

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => syncViewport())
        : null;
    resizeObserver?.observe(host);
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    window.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    window.addEventListener("touchmove", handleTouchMove, {
      passive: true,
    });
    window.addEventListener("touchend", handleTouchEnd, {
      passive: true,
    });
    window.addEventListener("touchcancel", handleTouchEnd, {
      passive: true,
    });
    window.addEventListener("pointerleave", resetPointerStroke);
    window.addEventListener("mouseout", handleWindowMouseOut);
    window.addEventListener("blur", resetPointerStroke);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("resize", syncViewport, { passive: true });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
      window.removeEventListener("pointerleave", resetPointerStroke);
      window.removeEventListener("mouseout", handleWindowMouseOut);
      window.removeEventListener("blur", resetPointerStroke);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("resize", syncViewport);
      resizeObserver?.disconnect();
      renderer.dispose();
    };
  }, []);

  return (
    <div ref={hostRef} className="conway-background" aria-hidden="true">
      <canvas ref={canvasRef} className="conway-background-canvas" />
    </div>
  );
}
