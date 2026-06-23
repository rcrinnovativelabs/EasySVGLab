"use strict";

const WORKSPACE_SIZE = 500;
const MIN_SIZE = 15;
const EDGE_MARGIN = 1; // Tiene anche lo spessore del tratto dentro il foglio.
const SVG_NS = "http://www.w3.org/2000/svg";
const SNAP_SCREEN_DISTANCE = 9;
const PENCIL_MIN_TOLERANCE = 0.25;
const PENCIL_MAX_TOLERANCE = 0.75;
const PENCIL_SAMPLE_DISTANCE = 0.8;
const GROUP_SELECTION_PADDING = 10;
const MEASURE_MM_PER_PX = 25.4 / 96;

const workspace = document.querySelector("#workspace");
const toolbar = document.querySelector(".toolbar");
const drawingLayer = document.querySelector("#drawing-layer");
const interactionLayer = document.querySelector("#interaction-layer");
const handlesLayer = document.querySelector("#handles-layer");
const sidesInput = document.querySelector("#polygon-sides");
const textValueInput = document.querySelector("#text-value");
const textSizeInput = document.querySelector("#text-size");
const textFontInput = document.querySelector("#text-font");
const toolButtons = [...document.querySelectorAll("[data-tool]")];
const saveDialog = document.querySelector("#save-dialog");
const saveForm = document.querySelector("#save-form");
const saveFileNameInput = document.querySelector("#save-file-name");
const saveNameError = document.querySelector("#save-name-error");
const confirmSaveButton = document.querySelector("#confirm-save-button");
const cancelSaveButton = document.querySelector("#cancel-save-button");
const undoButton = document.querySelector("#undo-button");
const redoButton = document.querySelector("#redo-button");
const separatePointsButton = document.querySelector("#separate-points-button");
const deleteSelectedPointButton = document.querySelector("#delete-selected-point-button");
const joinPencilButton = document.querySelector("#join-pencil-button");
const pointActions = document.querySelector("#point-actions");
const guideTitle = document.querySelector("#guide-title");
const guideText = document.querySelector("#guide-text");
const guideSteps = document.querySelector("#guide-steps");
const measurementEditor = document.querySelector("#measurement-editor");
const measurementEditorForm = document.querySelector("#measurement-editor-form");
const measurementValueInput = document.querySelector("#measurement-value");
const measurementUnitLabel = document.querySelector("#measurement-unit-label");
const measurementEditorError = document.querySelector("#measurement-editor-error");
const HISTORY_LIMIT = 100;
const AUTOSAVE_KEY = "easy-svg-lab-drawing";
const TAB_AUTOSAVE_PREFIX = "easy-svg-lab:";
const CANVAS_ZOOM_STEP = 0.1;
const CANVAS_MAX_ZOOM = 3;
const ERASER_RADIUS = 11;
const ERASER_SAMPLE_SPACING = 1.5;

let activeTool = "select";
let selectedShape = null;
let selectedShapes = [];
let groupSelectionFrame = null;
let dragState = null;
let penShape = null;
let pencilShape = null;
let pencilStartSnap = null;
let history = [""];
let historyIndex = 0;
let selectedPenPointIndex = null;
let penPreviewPoint = null;
let lineStartPoint = null;
let linePreviewPoint = null;
let lineStartSnap = null;
let arcStartPoint = null;
let arcEndPoint = null;
let arcPreviewPoint = null;
let arcStartSnap = null;
let arcEndSnap = null;
let penStartSnap = null;
let penEndSnap = null;
let hoveredShape = null;
let canvasBaseSize = 0;
let canvasZoom = 1;
let activeMeasurement = null;

function updateHistoryButtons() {
  undoButton.disabled = historyIndex === 0;
  redoButton.disabled = historyIndex === history.length - 1;
}

function saveDrawingLocally(snapshot = drawingLayer.innerHTML) {
  let savedPermanently = false;
  try {
    window.localStorage.setItem(AUTOSAVE_KEY, snapshot);
    savedPermanently = true;
  } catch {
    // Alcuni browser bloccano localStorage quando index.html è aperto come file.
  }

  if (!savedPermanently) {
    try {
      window.name = `${TAB_AUTOSAVE_PREFIX}${snapshot}`;
    } catch {
      // L'editor continua a funzionare anche se il browser blocca ogni salvataggio.
    }
  }
}

function restoreSavedDrawing() {
  let snapshot = null;
  try {
    snapshot = window.localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    // Prova il salvataggio della scheda qui sotto.
  }

  if (snapshot === null && window.name.startsWith(TAB_AUTOSAVE_PREFIX)) {
    snapshot = window.name.slice(TAB_AUTOSAVE_PREFIX.length);
  }
  if (snapshot === null) {
    return false;
  }

  drawingLayer.innerHTML = snapshot;
  normalizeClosedPenStorage();
  snapshot = drawingLayer.innerHTML;
  history = [snapshot];
  historyIndex = 0;
  return Boolean(snapshot);
}

function recordHistory() {
  const snapshot = drawingLayer.innerHTML;
  if (snapshot === history[historyIndex]) {
    saveDrawingLocally(snapshot);
    return;
  }

  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  if (history.length > HISTORY_LIMIT) {
    history.shift();
  }
  historyIndex = history.length - 1;
  saveDrawingLocally(snapshot);
  updateHistoryButtons();
}

function restoreHistory(index) {
  if (index < 0 || index >= history.length) {
    return;
  }

  historyIndex = index;
  drawingLayer.innerHTML = history[historyIndex];
  saveDrawingLocally(history[historyIndex]);
  penShape = null;
  pencilShape = null;
  dragState = null;
  selectedPenPointIndex = null;
  penPreviewPoint = null;
  lineStartPoint = null;
  linePreviewPoint = null;
  lineStartSnap = null;
  arcStartPoint = null;
  arcEndPoint = null;
  arcPreviewPoint = null;
  arcStartSnap = null;
  arcEndSnap = null;
  penStartSnap = null;
  penEndSnap = null;
  pencilStartSnap = null;
  hoveredShape = null;
  selectShape(null);
  setActiveTool("select");
  updateHistoryButtons();
}

function undo() {
  if (historyIndex > 0) {
    restoreHistory(historyIndex - 1);
  }
}

function redo() {
  if (historyIndex < history.length - 1) {
    restoreHistory(historyIndex + 1);
  }
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tagName);
  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, value);
  });
  return element;
}

function applyDefaultStyle(element) {
  element.setAttribute("fill", "none");
  element.setAttribute("stroke", "black");
  element.setAttribute("stroke-width", "2");
  element.setAttribute("stroke-linecap", "round");
  element.setAttribute("stroke-linejoin", "round");
  element.classList.add("drawable");
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function getSnapDistance() {
  const matrix = workspace.getScreenCTM();
  const screenScale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
  return SNAP_SCREEN_DISTANCE / Math.max(screenScale, 0.01);
}

function getArcData(shape) {
  try {
    return {
      start: JSON.parse(shape.dataset.arcStart),
      end: JSON.parse(shape.dataset.arcEnd),
      through: JSON.parse(shape.dataset.arcThrough)
    };
  } catch {
    return null;
  }
}

function getCircularArcGeometry(start, end, through) {
  const determinant = 2 * (
    start.x * (end.y - through.y)
    + end.x * (through.y - start.y)
    + through.x * (start.y - end.y)
  );
  if (Math.abs(determinant) < 0.01) {
    return null;
  }

  const startSquare = start.x ** 2 + start.y ** 2;
  const endSquare = end.x ** 2 + end.y ** 2;
  const throughSquare = through.x ** 2 + through.y ** 2;
  const center = {
    x: (
      startSquare * (end.y - through.y)
      + endSquare * (through.y - start.y)
      + throughSquare * (start.y - end.y)
    ) / determinant,
    y: (
      startSquare * (through.x - end.x)
      + endSquare * (start.x - through.x)
      + throughSquare * (end.x - start.x)
    ) / determinant
  };
  const radius = distance(center, start);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  const throughAngle = Math.atan2(through.y - center.y, through.x - center.x);
  const positiveDelta = (from, to) => {
    const fullTurn = Math.PI * 2;
    return ((to - from) % fullTurn + fullTurn) % fullTurn;
  };
  const positiveEndDelta = positiveDelta(startAngle, endAngle);
  const positiveThroughDelta = positiveDelta(startAngle, throughAngle);
  const sweep = positiveThroughDelta <= positiveEndDelta ? 1 : 0;
  const arcAngle = sweep ? positiveEndDelta : Math.PI * 2 - positiveEndDelta;

  return {
    center,
    radius,
    startAngle,
    endAngle,
    arcAngle,
    largeArc: arcAngle > Math.PI ? 1 : 0,
    sweep
  };
}

function getArcSamplePoints(start, end, through, sampleCount = 72) {
  const geometry = getCircularArcGeometry(start, end, through);
  if (!geometry) {
    return [start, end];
  }
  const positiveDelta = (
    (geometry.endAngle - geometry.startAngle) % (Math.PI * 2)
    + Math.PI * 2
  ) % (Math.PI * 2);
  const signedDelta = geometry.sweep
    ? positiveDelta
    : -(Math.PI * 2 - positiveDelta);

  return Array.from({ length: sampleCount + 1 }, (_, index) => {
    const angle = geometry.startAngle + signedDelta * index / sampleCount;
    return {
      x: geometry.center.x + Math.cos(angle) * geometry.radius,
      y: geometry.center.y + Math.sin(angle) * geometry.radius
    };
  });
}

function getArcStretch(shape) {
  return Number(shape?.dataset.arcStretch || 1);
}

function getArcWidth(shape) {
  return Number(shape?.dataset.arcWidth || 1);
}

function widenArcPoints(points, start, end, width) {
  if (Math.abs(width - 1) < 0.0001 || points.length < 2) {
    return points;
  }
  const chordLength = distance(start, end);
  if (chordLength < 0.01) {
    return points;
  }
  const direction = {
    x: (end.x - start.x) / chordLength,
    y: (end.y - start.y) / chordLength
  };
  return points.map((point, index) => {
    const t = index / (points.length - 1);
    const baseline = {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t
    };
    const horizontalDeviation = (
      (point.x - baseline.x) * direction.x
      + (point.y - baseline.y) * direction.y
    );
    return {
      x: point.x + direction.x * horizontalDeviation * (width - 1),
      y: point.y + direction.y * horizontalDeviation * (width - 1)
    };
  });
}

function stretchArcPoints(points, start, end, stretch) {
  if (Math.abs(stretch - 1) < 0.0001) {
    return points;
  }
  const chordLength = distance(start, end);
  if (chordLength < 0.01) {
    return points;
  }
  const midpoint = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2
  };
  const normal = {
    x: -(end.y - start.y) / chordLength,
    y: (end.x - start.x) / chordLength
  };
  return points.map((point) => {
    const normalOffset = (
      (point.x - midpoint.x) * normal.x
      + (point.y - midpoint.y) * normal.y
    );
    return {
      x: point.x + normal.x * normalOffset * (stretch - 1),
      y: point.y + normal.y * normalOffset * (stretch - 1)
    };
  });
}

function getDisplayedArcPoints(start, end, through, stretch = 1, width = 1) {
  return stretchArcPoints(
    widenArcPoints(
      getArcSamplePoints(start, end, through),
      start,
      end,
      width
    ),
    start,
    end,
    stretch
  );
}

function getDisplayedArcControlPoint(
  start,
  end,
  through,
  stretch = 1,
  width = 1
) {
  const geometry = getCircularArcGeometry(start, end, through);
  if (!geometry) {
    return { ...through };
  }
  const fullTurn = Math.PI * 2;
  const throughAngle = Math.atan2(
    through.y - geometry.center.y,
    through.x - geometry.center.x
  );
  const positiveDelta = (from, to) =>
    ((to - from) % fullTurn + fullTurn) % fullTurn;
  const travelledAngle = geometry.sweep
    ? positiveDelta(geometry.startAngle, throughAngle)
    : positiveDelta(throughAngle, geometry.startAngle);
  const t = clamp(travelledAngle / Math.max(geometry.arcAngle, 0.0001), 0, 1);
  const displayedPoints = getDisplayedArcPoints(
    start,
    end,
    through,
    stretch,
    width
  );
  const samplePosition = t * (displayedPoints.length - 1);
  const firstIndex = Math.floor(samplePosition);
  const secondIndex = Math.min(
    displayedPoints.length - 1,
    firstIndex + 1
  );
  const amount = samplePosition - firstIndex;
  const firstPoint = displayedPoints[firstIndex];
  const secondPoint = displayedPoints[secondIndex];
  return {
    x: firstPoint.x + (secondPoint.x - firstPoint.x) * amount,
    y: firstPoint.y + (secondPoint.y - firstPoint.y) * amount
  };
}

function getArcFrameFromData(start, end, through, stretch = 1, width = 1) {
  const data = { start, end, through };
  const chordLength = distance(data.start, data.end);
  const horizontal = {
    x: (data.end.x - data.start.x) / chordLength,
    y: (data.end.y - data.start.y) / chordLength
  };
  const vertical = { x: -horizontal.y, y: horizontal.x };
  const center = {
    x: (data.start.x + data.end.x) / 2,
    y: (data.start.y + data.end.y) / 2
  };
  const points = getDisplayedArcPoints(
    data.start,
    data.end,
    data.through,
    stretch,
    width
  );
  const horizontalValues = points.map((point) =>
    (point.x - center.x) * horizontal.x
    + (point.y - center.y) * horizontal.y
  );
  const verticalValues = points.map((point) =>
    (point.x - center.x) * vertical.x
    + (point.y - center.y) * vertical.y
  );
  const left = Math.min(...horizontalValues);
  const right = Math.max(...horizontalValues);
  const top = Math.min(...verticalValues);
  const bottom = Math.max(...verticalValues);
  const padding = 14 / canvasZoom;
  const toCanvasPoint = (horizontalValue, verticalValue) => ({
    x: center.x
      + horizontal.x * horizontalValue
      + vertical.x * verticalValue,
    y: center.y
      + horizontal.y * horizontalValue
      + vertical.y * verticalValue
  });
  return [
    toCanvasPoint(left - padding, top - padding),
    toCanvasPoint(right + padding, top - padding),
    toCanvasPoint(right + padding, bottom + padding),
    toCanvasPoint(left - padding, bottom + padding)
  ];
}

function getArcFrame(shape) {
  const data = getArcData(shape);
  return getArcFrameFromData(
    data.start,
    data.end,
    data.through,
    getArcStretch(shape),
    getArcWidth(shape)
  );
}

function getUnstretchedArcPoint(start, end, point, stretch = 1) {
  if (Math.abs(stretch - 1) < 0.0001) {
    return point;
  }
  return stretchArcPoints([point], start, end, 1 / stretch)[0];
}

function isArcInsideWorkspace(start, end, through, stretch = 1, width = 1) {
  return pointsAreInsideWorkspace(
    getDisplayedArcPoints(start, end, through, stretch, width)
  );
}

function getArcControlPoint(start, end, pointer, keepInside = true) {
  const chordLength = distance(start, end);
  if (chordLength < MIN_SIZE) {
    return pointer;
  }
  const midpoint = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2
  };
  const normal = {
    x: -(end.y - start.y) / chordLength,
    y: (end.x - start.x) / chordLength
  };
  let offset = (
    (pointer.x - midpoint.x) * normal.x
    + (pointer.y - midpoint.y) * normal.y
  );
  if (Math.abs(offset) < 2) {
    offset = (offset < 0 ? -1 : 1) * 2;
  }
  const pointAtOffset = (value) => ({
    x: midpoint.x + normal.x * value,
    y: midpoint.y + normal.y * value
  });
  const wantedPoint = pointAtOffset(offset);
  if (!keepInside || isArcInsideWorkspace(start, end, wantedPoint)) {
    return wantedPoint;
  }

  const direction = Math.sign(offset);
  let lower = 0.5;
  let upper = Math.abs(offset);
  let bestPoint = pointAtOffset(direction * lower);
  for (let index = 0; index < 30; index += 1) {
    const middle = (lower + upper) / 2;
    const candidate = pointAtOffset(direction * middle);
    if (isArcInsideWorkspace(start, end, candidate)) {
      lower = middle;
      bestPoint = candidate;
    } else {
      upper = middle;
    }
  }
  return bestPoint;
}

function getArcControlOffset(start, end, through) {
  const chordLength = distance(start, end);
  if (chordLength < 0.01) {
    return 0;
  }
  const midpoint = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2
  };
  const normal = {
    x: -(end.y - start.y) / chordLength,
    y: (end.x - start.x) / chordLength
  };
  return (
    (through.x - midpoint.x) * normal.x
    + (through.y - midpoint.y) * normal.y
  );
}

function getArcControlFromOffset(start, end, offset) {
  const chordLength = distance(start, end);
  const midpoint = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2
  };
  if (chordLength < 0.01) {
    return midpoint;
  }
  const normal = {
    x: -(end.y - start.y) / chordLength,
    y: (end.x - start.x) / chordLength
  };
  return {
    x: midpoint.x + normal.x * offset,
    y: midpoint.y + normal.y * offset
  };
}

function getArcControlAfterEndpointMove(
  previousStart,
  previousEnd,
  previousThrough,
  nextStart,
  nextEnd
) {
  const controlOffset = getArcControlOffset(
    previousStart,
    previousEnd,
    previousThrough
  );
  return getArcControlPoint(
    nextStart,
    nextEnd,
    getArcControlFromOffset(nextStart, nextEnd, controlOffset),
    false
  );
}

function getArcPathData(start, end, through) {
  const geometry = getCircularArcGeometry(start, end, through);
  if (!geometry) {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }
  return `M ${start.x} ${start.y} A ${geometry.radius} ${geometry.radius} 0 `
    + `${geometry.largeArc} ${geometry.sweep} ${end.x} ${end.y}`;
}

function setArcData(shape, start, end, through) {
  shape.dataset.arcStart = JSON.stringify(start);
  shape.dataset.arcEnd = JSON.stringify(end);
  shape.dataset.arcThrough = JSON.stringify(through);
  const stretch = getArcStretch(shape);
  const width = getArcWidth(shape);
  if (Math.abs(stretch - 1) < 0.0001
    && Math.abs(width - 1) < 0.0001) {
    shape.setAttribute("d", getArcPathData(start, end, through));
    return;
  }
  const points = getDisplayedArcPoints(start, end, through, stretch, width);
  shape.setAttribute(
    "d",
    points.map((point, index) =>
      `${index ? "L" : "M"} ${point.x} ${point.y}`
    ).join(" ")
  );
}

function getShapeVertices(shape) {
  const kind = shape.dataset.kind;

  if (kind === "rect") {
    const x = Number(shape.getAttribute("x"));
    const y = Number(shape.getAttribute("y"));
    const width = Number(shape.getAttribute("width"));
    const height = Number(shape.getAttribute("height"));
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ];
  }

  if (kind === "line") {
    return [{
      x: Number(shape.getAttribute("x1")),
      y: Number(shape.getAttribute("y1"))
    }, {
      x: Number(shape.getAttribute("x2")),
      y: Number(shape.getAttribute("y2"))
    }];
  }

  if (kind === "ellipse") {
    return getEllipseCardinalPoints(shape);
  }

  if (kind === "arc") {
    const data = getArcData(shape);
    if (!data) {
      return [];
    }
    const points = stretchArcPoints(
      [data.start, data.end],
      data.start,
      data.end,
      getArcStretch(shape)
    );
    return points;
  }

  if (kind === "pencil") {
    if (shape.dataset.closed === "true") {
      return [];
    }
    const points = getElementPoints(shape);
    return points.length > 1 ? [points[0], points[points.length - 1]] : points;
  }

  if (kind === "polygon" || kind === "pen") {
    const points = getElementPoints(shape);
    if (points.length > 1 && distance(points[0], points[points.length - 1]) < 0.01) {
      points.pop();
    }
    return points;
  }

  return [];
}

function findSnapPoint(point, excludedShape = null, extraCandidates = []) {
  const candidates = [...extraCandidates];

  [...drawingLayer.children].forEach((shape) => {
    if (shape !== excludedShape) {
      getShapeVertices(shape).forEach((vertex, vertexIndex) => {
        candidates.push({
          point: vertex,
          type: "vertex",
          shape,
          vertexIndex
        });
      });
    }
  });

  let closest = null;
  candidates.forEach((candidate) => {
    const candidateDistance = distance(point, candidate.point);
    if (candidateDistance <= getSnapDistance()
      && (!closest || candidateDistance < closest.distance)) {
      closest = { ...candidate, distance: candidateDistance };
    }
  });
  return closest;
}

function findSnapPointIncludingSegments(
  point,
  excludedShape = null,
  extraCandidates = [],
  excludedSameShapeSegments = null
) {
  const vertexSnap = findSnapPoint(point, excludedShape, extraCandidates);
  if (vertexSnap) {
    return vertexSnap;
  }

  let closest = null;
  [...drawingLayer.children].forEach((shape) => {
    if (shape === excludedShape && excludedSameShapeSegments === null) {
      return;
    }
    getDeletableSegments(shape).forEach((segment) => {
      if (shape === excludedShape
        && excludedSameShapeSegments.includes(segment.index)) {
        return;
      }
      const projectedPoint = projectPointOnSegment(
        point,
        segment.start,
        segment.end
      );
      const candidateDistance = distance(point, projectedPoint);
      if (candidateDistance <= getSnapDistance()
        && (!closest || candidateDistance < closest.distance)) {
        closest = {
          point: projectedPoint,
          type: "segment",
          shape,
          segmentIndex: segment.index,
          distance: candidateDistance
        };
      }
    });
  });
  return closest;
}

function renderActiveSnapMarker(point) {
  handlesLayer.append(
    createSvgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 8,
      class: "snap-active-halo"
    }),
    createSvgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 6,
      class: "snap-active-marker"
    })
  );
}

function renderSnapVertices(activeSnap = null, excludedShape = null) {
  [...drawingLayer.children].forEach((shape, shapeIndex) => {
    if (shape === excludedShape) {
      return;
    }
    getShapeVertices(shape).forEach((point) => {
      const isActive = activeSnap?.shape === shape
        && distance(activeSnap.point, point) < 0.01;
      handlesLayer.append(createSvgElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 4.5,
        class: isActive ? "snap-vertex active-snap-placeholder" : "snap-vertex",
        "data-shape-source": shapeIndex
      }));
      if (isActive) {
        renderActiveSnapMarker(point);
      }
    });
  });

  if (activeSnap && activeSnap.shape === excludedShape) {
    renderActiveSnapMarker(activeSnap.point);
  } else if (activeSnap?.type === "segment") {
    renderActiveSnapMarker(activeSnap.point);
  }
}

function getOpenPathPoints(shape) {
  if (!shape || !drawingLayer.contains(shape)) {
    return null;
  }
  if (shape.dataset.kind === "line") {
    return getShapeVertices(shape);
  }
  if (shape.dataset.kind === "pen" && shape.dataset.closed !== "true") {
    return getElementPoints(shape);
  }
  return null;
}

function orientPathToEnd(points, endpointIndex) {
  return endpointIndex === 0 ? [...points].reverse() : [...points];
}

function orientPathToStart(points, endpointIndex) {
  return endpointIndex === points.length - 1 ? [...points].reverse() : [...points];
}

function isOpenEndpointSnap(snap) {
  const points = getOpenPathPoints(snap?.shape);
  return Boolean(points)
    && (snap.vertexIndex === 0 || snap.vertexIndex === points.length - 1);
}

function mergeConnectedPath(newPoints, startSnap, endSnap, temporaryShape = null) {
  let mergedPoints = [...newPoints];
  const shapesToRemove = new Set();
  const closesExistingPath = isOpenEndpointSnap(startSnap)
    && isOpenEndpointSnap(endSnap)
    && startSnap.shape === endSnap.shape;
  const containsPencil = temporaryShape?.dataset.kind === "pencil"
    || startSnap?.shape?.dataset.kind === "pencil"
    || endSnap?.shape?.dataset.kind === "pencil";
  if (isOpenEndpointSnap(startSnap)) {
    const startPoints = getOpenPathPoints(startSnap.shape);
    mergedPoints = [
      ...orientPathToEnd(startPoints, startSnap.vertexIndex),
      ...mergedPoints.slice(1)
    ];
    shapesToRemove.add(startSnap.shape);
  }

  if (isOpenEndpointSnap(endSnap)
    && endSnap.shape !== startSnap?.shape) {
    const endPoints = getOpenPathPoints(endSnap.shape);
    mergedPoints = [
      ...mergedPoints,
      ...orientPathToStart(endPoints, endSnap.vertexIndex).slice(1)
    ];
    shapesToRemove.add(endSnap.shape);
  }

  if (!shapesToRemove.size) {
    return null;
  }

  temporaryShape?.remove();
  shapesToRemove.forEach((shape) => shape.remove());
  const mergedShape = createOpenPath(mergedPoints);
  if (containsPencil) {
    mergedShape.dataset.kind = "pencil";
  }
  if (closesExistingPath) {
    mergedShape.dataset.closed = "true";
  }
  drawingLayer.append(mergedShape);
  return mergedShape;
}

function isOpenEndpointIndex(shape, vertexIndex) {
  if (shape.dataset.kind === "line") {
    return vertexIndex === 0 || vertexIndex === 1;
  }
  if (shape.dataset.kind === "pen" && shape.dataset.closed !== "true") {
    const points = getElementPoints(shape);
    return vertexIndex === 0 || vertexIndex === points.length - 1;
  }
  return false;
}

function getRawSvgPoint(event) {
  const point = workspace.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(workspace.getScreenCTM().inverse());
}

function getSvgPoint(event) {
  const localPoint = getRawSvgPoint(event);

  return {
    x: clamp(localPoint.x, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN),
    y: clamp(localPoint.y, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN)
  };
}

function initializeCanvasZoom() {
  workspace.style.width = "";
  canvasBaseSize = workspace.getBoundingClientRect().width;
  canvasZoom = 1;
  workspace.style.setProperty("--control-scale", "1");
}

function updateCanvasZoom(nextZoom) {
  canvasZoom = clamp(nextZoom, 1, CANVAS_MAX_ZOOM);
  workspace.style.width = `${canvasBaseSize * canvasZoom}px`;
  workspace.style.setProperty("--control-scale", String(1 / canvasZoom));
  if (!dragState && activeTool === "select") {
    renderHandles();
  }
  updateSeparatePointsButton();
}

function cloneFrame(frame) {
  return frame?.map((point) => ({ x: point.x, y: point.y })) || null;
}

function isValidFrame(frame) {
  return Array.isArray(frame)
    && frame.length === 4
    && frame.every((point) =>
      Number.isFinite(point?.x) && Number.isFinite(point?.y)
    );
}

function getStoredGroupSelectionFrame(shapes) {
  if (!shapes.length) {
    return null;
  }

  const paddingKey = String(GROUP_SELECTION_PADDING);
  const hasCurrentPadding = shapes.every((shape) =>
    shape.dataset.groupSelectionFramePadding === paddingKey
  );
  if (!hasCurrentPadding) {
    return null;
  }

  const frames = shapes.map((shape) => shape.dataset.groupSelectionFrame);
  if (!frames.every(Boolean) || !frames.every((frame) => frame === frames[0])) {
    return null;
  }

  try {
    const frame = JSON.parse(frames[0]);
    return isValidFrame(frame) ? cloneFrame(frame) : null;
  } catch {
    return null;
  }
}

function storeGroupSelectionFrame(shapes, frame) {
  if (!shapes.length || !isValidFrame(frame)) {
    return;
  }

  const value = JSON.stringify(cloneFrame(frame));
  const paddingKey = String(GROUP_SELECTION_PADDING);
  shapes.forEach((shape) => {
    if (shape && drawingLayer.contains(shape)) {
      shape.dataset.groupSelectionFrame = value;
      shape.dataset.groupSelectionFramePadding = paddingKey;
    }
  });
}


const GUIDE_MESSAGES = {
  select: {
    title: "Seleziona",
    text: "Usa questo strumento per selezionare una forma già disegnata.",
    steps: [
      "Clicca una forma sul foglio.",
      "Trascina il punto centrale per spostarla.",
      "Usa i punti sul bordo per modificarla."
    ]
  },
  rect: {
    title: "Rettangolo",
    text: "Crea un rettangolo o un quadrato.",
    steps: [
      "Clicca nel punto in cui vuoi inserirlo.",
      "Dopo averlo creato, trascina i punti agli angoli.",
      "Puoi cambiare larghezza e altezza"
    ]
  },
  circle: {
    title: "Cerchio",
    text: "Crea un cerchio.",
    steps: [
      "Clicca nel punto in cui vuoi inserirlo.",
      "Trascina il punto sulla circonferenza per ingrandirlo o rimpicciolirlo."
    ]
  },
  ellipse: {
    title: "Ovale",
    text: "Crea una forma ovale.",
    steps: [
      "Clicca nel punto in cui vuoi inserirla.",
      "Usa i punti laterali per cambiare larghezza e altezza."
    ]
  },
  polygon: {
    title: "Poligono",
    text: "Crea una forma con più lati.",
    steps: [
      "Scegli il numero di lati.",
      "Clicca sul foglio per creare il poligono.",
      "Trascina i punti per modificare la forma."
    ]
  },
  line: {
    title: "Linea",
    text: "Disegna un segmento tra due punti.",
    steps: [
      "Clicca dove deve iniziare la linea.",
      "Clicca dove deve finire.",
      "Puoi agganciare la linea ai punti di altre forme."
    ]
  },
  arc: {
    title: "Arco",
    text: "Disegna una linea curva.",
    steps: [
      "Clicca il punto iniziale.",
      "Clicca il punto finale.",
      "Clicca un terzo punto per decidere quanto deve curvare."
    ]
  },
  pen: {
    title: "Penna",
    text: "Disegna una forma usando più punti.",
    steps: [
      "Clicca per inserire il primo punto.",
      "Continua a cliccare per aggiungere altri punti.",
      "Torna sul primo punto se vuoi chiudere la forma."
    ]
  },
  pencil: {
    title: "Matita",
    text: "Disegna liberamente, come su un foglio.",
    steps: [
      "Tieni premuto sul foglio.",
      "Trascina per disegnare.",
      "Rilascia quando hai finito."
    ]
  },
  text: {
    title: "Testo",
    text: "Inserisci una scritta nel disegno.",
    steps: [
      "Scrivi il testo nel campo Scritta.",
      "Scegli grandezza e stile.",
      "Clicca sul foglio per posizionarlo."
    ]
  },
  "add-point": {
    title: "Aggiungi punto",
    text: "Aggiunge un nuovo punto su una linea o su un lato.",
    steps: [
      "Avvicinati al tratto che vuoi modificare.",
      "Clicca sul tratto.",
      "Poi seleziona il nuovo punto e trascinalo."
    ]
  },
  eraser: {
    title: "Gomma",
    text: "Cancella parti disegnate con la Matita.",
    steps: [
      "Passa sopra il tratto da cancellare.",
      "Funziona sui disegni fatti con Matita."
    ]
  },
  "delete-edge": {
    title: "Elimina lato",
    text: "Rimuove un lato da una forma composta da segmenti.",
    steps: [
      "Clicca il lato da eliminare.",
      "La forma si aprirà in quel punto."
    ]
  },
  measure: {
    title: "Misure",
    text: "Permette di selezionare lati e angoli e modificarli con valori numerici.",
    steps: [
      "Seleziona una forma composta da segmenti.",
      "Passa sopra un lato o un vertice per evidenziarlo.",
      "Clicca e modifica il valore nel riquadro."
    ]
  }
};

function getSelectedShapeGuide() {
  if (!selectedShape || !drawingLayer.contains(selectedShape)) {
    return null;
  }

  if (selectedPenPointIndex !== null) {
    return {
      title: "Punto selezionato",
      text: "Hai selezionato un punto della forma.",
      steps: [
        "Trascinalo per cambiare il disegno.",
        "Usa Separa punti per scollegarlo da un altro punto.",
        "Usa Elimina punto per rimuoverlo."
      ]
    };
  }

  const kind = selectedShape.dataset.kind;

  if (kind === "arc") {
    return {
      title: "Arco selezionato",
      text: "Puoi modificare estremi, curva e altezza dell’arco.",
      steps: [
        "Trascina gli estremi per spostare inizio e fine.",
        "Trascina il punto giallo per cambiare la curva.",
        "Trascina il quadratino per cambiare l’altezza."
      ]
    };
  }

  if (kind === "text") {
    return {
      title: "Testo selezionato",
      text: "Puoi spostare, ruotare o modificare la scritta.",
      steps: [
        "Cambia Scritta, Grandezza o Stile nella sezione Testo.",
        "Trascina il punto centrale per spostarla.",
        "Usa la maniglia di rotazione per girarla."
      ]
    };
  }

  if (kind === "pen") {
    return {
      title: "Tracciato selezionato",
      text: "Questa forma è costruita con più punti collegati.",
      steps: [
        "Trascina un punto per cambiare il contorno.",
        "Usa Aggiungi punto per rendere il tracciato più dettagliato.",
        "Usa Elimina lato se vuoi aprire una parte della forma."
      ]
    };
  }

  if (kind === "polygon") {
    return {
      title: "Poligono selezionato",
      text: "Puoi modificare i vertici del poligono.",
      steps: [
        "Trascina un punto per cambiare la forma.",
        "Usa Aggiungi punto se vuoi creare un nuovo vertice.",
        "Usa Elimina lato per aprire il poligono."
      ]
    };
  }

  if (kind === "line") {
    return {
      title: "Linea selezionata",
      text: "Puoi spostare la linea o cambiare i suoi estremi.",
      steps: [
        "Trascina un estremo per cambiare direzione o lunghezza.",
        "Trascina il punto centrale per spostarla."
      ]
    };
  }

  if (kind === "circle") {
    return {
      title: "Cerchio selezionato",
      text: "Puoi spostare il cerchio o cambiarne la grandezza.",
      steps: [
        "Trascina il punto centrale per spostarlo.",
        "Trascina il punto sul bordo per ingrandirlo o rimpicciolirlo."
      ]
    };
  }

  if (kind === "ellipse") {
    return {
      title: "Ovale selezionato",
      text: "Puoi cambiare larghezza e altezza dell’ovale.",
      steps: [
        "Trascina il punto centrale per spostarlo.",
        "Usa i punti laterali per modificarne la forma."
      ]
    };
  }

  if (kind === "rect") {
    return {
      title: "Rettangolo selezionato",
      text: "Puoi cambiare dimensione e posizione del rettangolo.",
      steps: [
        "Trascina il punto centrale per spostarlo.",
        "Trascina gli angoli per cambiare larghezza e altezza."
      ]
    };
  }

  return {
    title: "Forma selezionata",
    text: "Puoi spostare o modificare questa forma.",
    steps: [
      "Trascina il punto centrale per spostarla.",
      "Usa i punti sul bordo per cambiarla.",
      "Usa Elimina forma se vuoi rimuoverla."
    ]
  };
}

function updateGuidePanel() {
  if (!guideTitle || !guideText || !guideSteps) {
    return;
  }

  const guide = getSelectedShapeGuide() || GUIDE_MESSAGES[activeTool] || GUIDE_MESSAGES.select;
  guideTitle.textContent = guide.title;
  guideText.textContent = guide.text;
  guideSteps.replaceChildren(...guide.steps.map((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    return item;
  }));
}

function setActiveTool(tool) {
  if (penShape) {
    finishPenPath();
  }
  if (lineStartPoint) {
    cancelLine();
  }
  if (arcStartPoint) {
    cancelArc();
  }

  activeTool = tool;
  toolbar.dataset.activeTool = tool;
  workspace.dataset.tool = tool;
  dragState = null;
  selectedPenPointIndex = null;
  hoveredShape = null;
  if (tool !== "measure") {
    activeMeasurement = null;
    closeMeasurementEditor();
  }
  updateSeparatePointsButton();
  updateGuidePanel();

  toolButtons.forEach((button) => {
    const isActive = button.dataset.tool === tool;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  if (tool === "measure") {
    interactionLayer.replaceChildren();
    renderMeasurementControls();
  } else if (tool === "delete-edge") {
    interactionLayer.replaceChildren();
    selectShape(null);
    renderEdgeDeleteTargets();
  } else if (tool === "add-point") {
    interactionLayer.replaceChildren();
    selectShape(null);
    renderAddPointTargets();
    renderSnapVertices();
  } else if (tool === "line" || tool === "arc" || tool === "pen" || tool === "pencil") {
    selectShape(null);
    handlesLayer.replaceChildren();
    renderSnapVertices();
  } else if (tool === "eraser") {
    selectShape(null);
    handlesLayer.replaceChildren();
  } else {
    renderHandles();
  }
}

function getDetachedTopologyIndexes(shape) {
  try {
    return new Set(JSON.parse(shape?.dataset.detachedTopology || "[]"));
  } catch {
    shape?.removeAttribute("data-detached-topology");
    return new Set();
  }
}

function isTopologyPointDetached(shape, index) {
  return getDetachedTopologyIndexes(shape).has(index);
}

function detachTopologyPoint(shape, index) {
  const indexes = getDetachedTopologyIndexes(shape);
  indexes.add(index);
  shape.dataset.detachedTopology = JSON.stringify([...indexes]);
}

function attachTopologyPoint(shape, index) {
  if (!shape || !Number.isInteger(index)) {
    return;
  }
  const indexes = getDetachedTopologyIndexes(shape);
  indexes.delete(index);
  if (indexes.size) {
    shape.dataset.detachedTopology = JSON.stringify([...indexes]);
  } else {
    shape.removeAttribute("data-detached-topology");
  }
}

function reconnectDraggedTopologySnap() {
  const snap = dragState?.activeSnap;
  const sourcePoint = getDraggedTopologyPoint(
    selectedShape,
    dragState?.type,
    dragState?.index
  );
  if (!snap || !sourcePoint || snap.type !== "vertex" || !snap.shape) {
    return false;
  }
  attachTopologyPoint(selectedShape, dragState.index);
  attachTopologyPoint(snap.shape, snap.vertexIndex);
  return true;
}

function topologyPointsAreConnected(
  firstShape,
  firstIndex,
  firstPoint,
  secondShape,
  secondIndex,
  secondPoint
) {
  return !isTopologyPointDetached(firstShape, firstIndex)
    && !isTopologyPointDetached(secondShape, secondIndex)
    && distance(firstPoint, secondPoint) < 0.01;
}

function getConnectedShapeComponent(originShape) {
  if (!originShape || !drawingLayer.contains(originShape)) {
    return [];
  }

  const component = new Set([originShape]);
  const pending = [originShape];
  while (pending.length) {
    const shape = pending.shift();
    const shapePoints = getTopologyPoints(shape);
    if (!shapePoints.length) {
      continue;
    }

    [...drawingLayer.children].forEach((candidate) => {
      if (component.has(candidate)) {
        return;
      }
      const candidatePoints = getTopologyPoints(candidate);
      const isConnected = shapePoints.some((point, pointIndex) =>
        candidatePoints.some((candidatePoint, candidateIndex) =>
          topologyPointsAreConnected(
            shape,
            pointIndex,
            point,
            candidate,
            candidateIndex,
            candidatePoint
          )
        )
      );
      if (isConnected) {
        component.add(candidate);
        pending.push(candidate);
      }
    });
  }
  return [...component];
}

function selectShape(shape) {
  const connectedShapes = getConnectedShapeComponent(shape);
  if (connectedShapes.length > 1) {
    selectShapes(connectedShapes, shape);
    return;
  }
  selectedShape = shape && drawingLayer.contains(shape) ? shape : null;
  selectedShapes = selectedShape ? [selectedShape] : [];
  groupSelectionFrame = null;
  toolbar.classList.toggle("editing-text", selectedShape?.dataset.kind === "text");
  if (selectedShape?.dataset.kind === "text") {
    textValueInput.value = selectedShape.textContent;
    textSizeInput.value = Number(selectedShape.getAttribute("font-size"));
    textFontInput.value = selectedShape.getAttribute("font-family");
    if (!textFontInput.value) {
      textFontInput.selectedIndex = 0;
    }
  }
  selectedPenPointIndex = null;
  updateSeparatePointsButton();
  updateGuidePanel();
  if (activeTool === "measure") {
    renderMeasurementControls();
  } else if (activeTool === "delete-edge") {
    renderEdgeDeleteTargets();
  } else if (activeTool === "add-point") {
    renderAddPointTargets();
  } else {
    renderHandles();
  }
}

function selectShapes(shapes, focusedShape = null) {
  const previousSelectedShapes = [...selectedShapes];
  const previousGroupSelectionFrame = cloneFrame(groupSelectionFrame);

  const expandedShapes = shapes.flatMap((shape) =>
    getConnectedShapeComponent(shape)
  );
  selectedShapes = [...new Set(expandedShapes)]
    .filter((shape) => drawingLayer.contains(shape));
  selectedShape = focusedShape && selectedShapes.includes(focusedShape)
    ? focusedShape
    : selectedShapes.length === 1
      ? selectedShapes[0]
      : null;

  if (selectedShapes.length > 1) {
    const sameSelection = previousGroupSelectionFrame
      && previousSelectedShapes.length === selectedShapes.length
      && selectedShapes.every((shape) => previousSelectedShapes.includes(shape));
    const storedFrame = getStoredGroupSelectionFrame(selectedShapes);

    if (sameSelection) {
      groupSelectionFrame = previousGroupSelectionFrame;
    } else if (storedFrame) {
      groupSelectionFrame = storedFrame;
    } else {
      groupSelectionFrame = getGroupSelectionFrameFromBounds(selectedShapes);
    }
    storeGroupSelectionFrame(selectedShapes, groupSelectionFrame);
  } else {
    groupSelectionFrame = null;
  }

  toolbar.classList.toggle(
    "editing-text",
    selectedShapes.length === 1 && selectedShape?.dataset.kind === "text"
  );

  if (selectedShape?.dataset.kind === "text") {
    textValueInput.value = selectedShape.textContent;
    textSizeInput.value = Number(selectedShape.getAttribute("font-size"));
    textFontInput.value = selectedShape.getAttribute("font-family");
    if (!textFontInput.value) {
      textFontInput.selectedIndex = 0;
    }
  }

  selectedPenPointIndex = null;
  updateSeparatePointsButton();
  updateGuidePanel();
  if (activeTool === "measure") {
    renderMeasurementControls();
  } else {
    renderHandles();
  }
}

function toggleShapeSelection(shape) {
  if (!shape || !drawingLayer.contains(shape)) {
    return;
  }

  const component = getConnectedShapeComponent(shape);
  const componentSet = new Set(component);
  const isSelected = component.every((item) => selectedShapes.includes(item));
  const nextSelection = isSelected
    ? selectedShapes.filter((selected) => !componentSet.has(selected))
    : [...selectedShapes, ...component];
  selectShapes(nextSelection);
}

function getShapeBounds(shape) {
  let points;
  if (shape.dataset.kind === "text") {
    points = getTextRotatedCorners(shape);
  } else if (shape.dataset.kind === "ellipse") {
    const bounds = getEllipseBounds(shape);
    points = [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
    ];
  } else if (shape.dataset.kind === "circle") {
    const cx = Number(shape.getAttribute("cx"));
    const cy = Number(shape.getAttribute("cy"));
    const radius = Number(shape.getAttribute("r"));
    points = [
      { x: cx - radius, y: cy - radius },
      { x: cx + radius, y: cy + radius }
    ];
  } else if (shape.dataset.kind === "rect") {
    const box = shape.getBBox();
    points = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y + box.height }
    ];
  } else if (["polygon", "pen", "pencil"].includes(shape.dataset.kind)) {
    points = getElementPoints(shape);
  } else if (shape.dataset.kind === "arc") {
    const box = shape.getBBox();
    points = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y + box.height }
    ];
  } else {
    points = getShapeVertices(shape);
  }

  if (!points.length) {
    const box = shape.getBBox();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y
  };
}

function getShapesBounds(shapes) {
  const boxes = shapes.map(getShapeBounds);
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

function getGroupSelectionFrameFromBounds(shapes) {
  const box = getShapesBounds(shapes);
  const padding = GROUP_SELECTION_PADDING;
  return [
    { x: box.x - padding, y: box.y - padding },
    { x: box.x + box.width + padding, y: box.y - padding },
    { x: box.x + box.width + padding, y: box.y + box.height + padding },
    { x: box.x - padding, y: box.y + box.height + padding }
  ];
}

function getGroupSelectionBoundaryPoints(shape) {
  if (!shape || !drawingLayer.contains(shape)) {
    return [];
  }

  if (shape.dataset.kind === "circle") {
    const cx = Number(shape.getAttribute("cx"));
    const cy = Number(shape.getAttribute("cy"));
    const radius = Number(shape.getAttribute("r"));
    return [
      { x: cx - radius, y: cy },
      { x: cx + radius, y: cy },
      { x: cx, y: cy - radius },
      { x: cx, y: cy + radius }
    ];
  }

  if (shape.dataset.kind === "ellipse") {
    return getEllipseCardinalPoints(shape);
  }

  if (shape.dataset.kind === "text") {
    return getTextRotatedCorners(shape);
  }

  if (shape.dataset.kind === "arc") {
    const data = getArcData(shape);
    if (!data) {
      return [];
    }
    return getDisplayedArcPoints(
      data.start,
      data.end,
      data.through,
      getArcStretch(shape),
      getArcWidth(shape)
    );
  }

  if (["polygon", "pen", "pencil"].includes(shape.dataset.kind)) {
    return getElementPoints(shape);
  }

  return getShapeVertices(shape);
}

function getGroupSelectionFrameFromReference(shapes, referenceFrame) {
  if (!isValidFrame(referenceFrame)) {
    return getGroupSelectionFrameFromBounds(shapes);
  }

  const horizontalLength = distance(referenceFrame[0], referenceFrame[1]);
  const verticalLength = distance(referenceFrame[0], referenceFrame[3]);
  if (horizontalLength < 0.01 || verticalLength < 0.01) {
    return getGroupSelectionFrameFromBounds(shapes);
  }

  const horizontal = {
    x: (referenceFrame[1].x - referenceFrame[0].x) / horizontalLength,
    y: (referenceFrame[1].y - referenceFrame[0].y) / horizontalLength
  };
  const vertical = {
    x: (referenceFrame[3].x - referenceFrame[0].x) / verticalLength,
    y: (referenceFrame[3].y - referenceFrame[0].y) / verticalLength
  };
  const origin = getFrameCenter(referenceFrame);
  const points = shapes.flatMap(getGroupSelectionBoundaryPoints);

  if (!points.length) {
    return cloneFrame(referenceFrame);
  }

  const horizontalValues = points.map((point) =>
    (point.x - origin.x) * horizontal.x
    + (point.y - origin.y) * horizontal.y
  );
  const verticalValues = points.map((point) =>
    (point.x - origin.x) * vertical.x
    + (point.y - origin.y) * vertical.y
  );
  const padding = GROUP_SELECTION_PADDING;
  const left = Math.min(...horizontalValues) - padding;
  const right = Math.max(...horizontalValues) + padding;
  const top = Math.min(...verticalValues) - padding;
  const bottom = Math.max(...verticalValues) + padding;
  const toCanvasPoint = (horizontalValue, verticalValue) => ({
    x: origin.x + horizontal.x * horizontalValue + vertical.x * verticalValue,
    y: origin.y + horizontal.y * horizontalValue + vertical.y * verticalValue
  });

  return [
    toCanvasPoint(left, top),
    toCanvasPoint(right, top),
    toCanvasPoint(right, bottom),
    toCanvasPoint(left, bottom)
  ];
}

function updateGroupSelectionFrameFromCurrentGeometry() {
  if (selectedShapes.length <= 1 || !groupSelectionFrame) {
    return;
  }

  groupSelectionFrame = getGroupSelectionFrameFromReference(
    selectedShapes,
    groupSelectionFrame
  );
  storeGroupSelectionFrame(selectedShapes, groupSelectionFrame);
}

function boxesIntersect(first, second) {
  return first.x <= second.x + second.width
    && first.x + first.width >= second.x
    && first.y <= second.y + second.height
    && first.y + first.height >= second.y;
}

function renderSelectionInteractionLayer() {
  interactionLayer.replaceChildren();
  if (activeTool !== "select" && activeTool !== "measure") {
    return;
  }

  [...drawingLayer.children].forEach((shape, shapeIndex) => {
    const hitShape = shape.cloneNode(true);
    hitShape.removeAttribute("id");
    hitShape.removeAttribute("style");
    hitShape.removeAttribute("class");
    hitShape.setAttribute("class", "selection-hit");
    hitShape.dataset.shapeIndex = shapeIndex;
    interactionLayer.append(hitShape);
  });
}

function getShapeHandlePoints(shape) {
  const kind = shape.dataset.kind;
  if (kind === "circle") {
    return [{
      x: Number(shape.getAttribute("cx")) + Number(shape.getAttribute("r")),
      y: Number(shape.getAttribute("cy"))
    }];
  }
  if (kind === "rect"
    || kind === "ellipse"
    || kind === "line"
    || kind === "arc"
    || kind === "polygon"
    || kind === "pen"
    || kind === "pencil") {
    return getShapeVertices(shape);
  }
  return [];
}

function renderHoveredShapeHandles() {
  if (activeTool !== "select"
    || !hoveredShape
    || !drawingLayer.contains(hoveredShape)
    || selectedShapes.includes(hoveredShape)
    || dragState) {
    return;
  }

  getShapeHandlePoints(hoveredShape).forEach((point) => {
    handlesLayer.append(createSvgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 3.8,
      class: "hover-handle"
    }));
  });

  const center = getMoveHandlePoint(hoveredShape);
  const shapeIndex = [...drawingLayer.children].indexOf(hoveredShape);
  handlesLayer.querySelectorAll(".hover-handle").forEach((handle) => {
    handle.dataset.shapeSource = shapeIndex;
  });
  handlesLayer.append(createSvgElement("circle", {
    cx: center.x,
    cy: center.y,
    r: 9,
    fill: "transparent",
    stroke: "transparent",
    class: "hover-move-target",
    "data-hover-move": shapeIndex,
    "data-shape-source": shapeIndex
  }), createSvgElement("circle", {
    cx: center.x,
    cy: center.y,
    r: 8,
    fill: "#eef0ff",
    stroke: "#4d5fc1",
    "stroke-width": 2.5,
    "pointer-events": "none",
    class: "hover-move-ring"
  }), createSvgElement("circle", {
    cx: center.x,
    cy: center.y,
    r: 3.5,
    fill: "#4d5fc1",
    stroke: "none",
    "pointer-events": "none",
    class: "hover-move-center"
  }));
}

function appendAndSelect(shape) {
  applyDefaultStyle(shape);
  drawingLayer.append(shape);
  selectShape(shape);
  recordHistory();
  setActiveTool("select");
}

function createRectangle(point) {
  const size = 80;
  const x = clamp(point.x - size / 2, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN - size);
  const y = clamp(point.y - size / 2, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN - size);
  const rectangle = createSvgElement("rect", { x, y, width: size, height: size });
  rectangle.dataset.kind = "rect";
  appendAndSelect(rectangle);
}

function createCircle(point) {
  const radius = 40;
  const cx = clamp(point.x, radius + EDGE_MARGIN, WORKSPACE_SIZE - radius - EDGE_MARGIN);
  const cy = clamp(point.y, radius + EDGE_MARGIN, WORKSPACE_SIZE - radius - EDGE_MARGIN);
  const circle = createSvgElement("circle", { cx, cy, r: radius });
  circle.dataset.kind = "circle";
  appendAndSelect(circle);
}

function createEllipse(point) {
  const radiusX = 55;
  const radiusY = 35;
  const cx = clamp(
    point.x,
    radiusX + EDGE_MARGIN,
    WORKSPACE_SIZE - radiusX - EDGE_MARGIN
  );
  const cy = clamp(
    point.y,
    radiusY + EDGE_MARGIN,
    WORKSPACE_SIZE - radiusY - EDGE_MARGIN
  );
  const ellipse = createSvgElement("ellipse", {
    cx,
    cy,
    rx: radiusX,
    ry: radiusY
  });
  ellipse.dataset.kind = "ellipse";
  appendAndSelect(ellipse);
}

function keepTextInsideWorkspace(textElement) {
  let box = textElement.getBBox();
  let x = Number(textElement.getAttribute("x"));
  let y = Number(textElement.getAttribute("y"));

  if (box.width > WORKSPACE_SIZE - EDGE_MARGIN * 2
    || box.height > WORKSPACE_SIZE - EDGE_MARGIN * 2) {
    return false;
  }

  if (box.x < EDGE_MARGIN) {
    x += EDGE_MARGIN - box.x;
  } else if (box.x + box.width > WORKSPACE_SIZE - EDGE_MARGIN) {
    x -= box.x + box.width - (WORKSPACE_SIZE - EDGE_MARGIN);
  }

  if (box.y < EDGE_MARGIN) {
    y += EDGE_MARGIN - box.y;
  } else if (box.y + box.height > WORKSPACE_SIZE - EDGE_MARGIN) {
    y -= box.y + box.height - (WORKSPACE_SIZE - EDGE_MARGIN);
  }

  textElement.setAttribute("x", x);
  textElement.setAttribute("y", y);
  applyTextRotation(textElement);
  box = textElement.getBBox();
  const corners = getTextRotatedCorners(textElement);
  const minimumX = Math.min(...corners.map((point) => point.x));
  const maximumX = Math.max(...corners.map((point) => point.x));
  const minimumY = Math.min(...corners.map((point) => point.y));
  const maximumY = Math.max(...corners.map((point) => point.y));
  const offsetX = minimumX < EDGE_MARGIN
    ? EDGE_MARGIN - minimumX
    : maximumX > WORKSPACE_SIZE - EDGE_MARGIN
      ? WORKSPACE_SIZE - EDGE_MARGIN - maximumX
      : 0;
  const offsetY = minimumY < EDGE_MARGIN
    ? EDGE_MARGIN - minimumY
    : maximumY > WORKSPACE_SIZE - EDGE_MARGIN
      ? WORKSPACE_SIZE - EDGE_MARGIN - maximumY
      : 0;

  if (offsetX || offsetY) {
    textElement.setAttribute("x", Number(textElement.getAttribute("x")) + offsetX);
    textElement.setAttribute("y", Number(textElement.getAttribute("y")) + offsetY);
    applyTextRotation(textElement);
  }
  return pointsAreInsideWorkspace(getTextRotatedCorners(textElement));
}

function createText(point) {
  const value = textValueInput.value.trim();
  if (!value) {
    textValueInput.focus();
    return;
  }

  const fontSize = clamp(Number.parseInt(textSizeInput.value, 10) || 32, 8, 120);
  const fontFamily = textFontInput.value;
  textSizeInput.value = fontSize;
  const textElement = createSvgElement("text", {
    x: point.x,
    y: point.y,
    "font-size": fontSize,
    "font-family": fontFamily,
    fill: "black",
    stroke: "none"
  });
  textElement.textContent = value;
  textElement.dataset.kind = "text";
  textElement.classList.add("drawable");
  drawingLayer.append(textElement);

  if (!keepTextInsideWorkspace(textElement)) {
    textElement.remove();
    return;
  }

  selectShape(textElement);
  recordHistory();
  setActiveTool("select");
}

function beginLine(point) {
  const snap = findSnapPoint(point);
  lineStartPoint = snap ? { ...snap.point } : point;
  linePreviewPoint = lineStartPoint;
  lineStartSnap = snap;
  selectShape(null);
  renderLineDraft();
}

function finishLine(point) {
  const snap = findSnapPoint(point);
  const endPoint = snap ? { ...snap.point } : point;
  if (distance(lineStartPoint, endPoint) < MIN_SIZE) {
    return;
  }

  const points = [lineStartPoint, endPoint];
  const mergedShape = mergeConnectedPath(points, lineStartSnap, snap);
  let line = mergedShape;
  if (!line) {
    line = createSvgElement("line", {
      x1: lineStartPoint.x,
      y1: lineStartPoint.y,
      x2: endPoint.x,
      y2: endPoint.y
    });
    line.dataset.kind = "line";
    applyDefaultStyle(line);
    drawingLayer.append(line);
  }
  lineStartPoint = null;
  linePreviewPoint = null;
  lineStartSnap = null;
  selectShape(line);
  recordHistory();
  setActiveTool("select");
}

function beginArc(point) {
  const snap = findSnapPoint(point);
  arcStartPoint = snap ? { ...snap.point } : point;
  arcPreviewPoint = arcStartPoint;
  arcStartSnap = snap;
  selectShape(null);
  renderArcDraft();
}

function setArcEnd(point) {
  const snap = findSnapPoint(point);
  const endPoint = snap ? { ...snap.point } : point;
  if (distance(arcStartPoint, endPoint) < MIN_SIZE) {
    return;
  }
  arcEndPoint = endPoint;
  arcPreviewPoint = {
    x: (arcStartPoint.x + arcEndPoint.x) / 2,
    y: (arcStartPoint.y + arcEndPoint.y) / 2 - 40
  };
  arcEndSnap = snap;
  renderArcDraft();
}

function finishArc(point) {
  const controlPoint = getArcControlPoint(arcStartPoint, arcEndPoint, point);
  const geometry = getCircularArcGeometry(
    arcStartPoint,
    arcEndPoint,
    controlPoint
  );
  if (!geometry) {
    return;
  }
  const arc = createSvgElement("path");
  arc.dataset.kind = "arc";
  setArcData(arc, arcStartPoint, arcEndPoint, controlPoint);
  applyDefaultStyle(arc);
  drawingLayer.append(arc);
  arcStartPoint = null;
  arcEndPoint = null;
  arcPreviewPoint = null;
  arcStartSnap = null;
  arcEndSnap = null;
  selectShape(arc);
  recordHistory();
  setActiveTool("select");
}

function cancelArc() {
  arcStartPoint = null;
  arcEndPoint = null;
  arcPreviewPoint = null;
  arcStartSnap = null;
  arcEndSnap = null;
  handlesLayer.replaceChildren();
}

function renderArcDraft() {
  handlesLayer.replaceChildren();
  if (!arcStartPoint) {
    return;
  }
  if (!arcEndPoint) {
    const snap = findSnapPoint(arcPreviewPoint);
    const end = snap ? snap.point : arcPreviewPoint;
    handlesLayer.append(createSvgElement("line", {
      x1: arcStartPoint.x,
      y1: arcStartPoint.y,
      x2: end.x,
      y2: end.y,
      class: "pen-preview"
    }));
    [arcStartPoint, end].forEach((draftPoint) => {
      handlesLayer.append(createSvgElement("circle", {
        cx: draftPoint.x,
        cy: draftPoint.y,
        r: 4.5,
        class: "draft-point"
      }));
    });
    renderSnapVertices(snap);
    return;
  }

  const controlPoint = getArcControlPoint(
    arcStartPoint,
    arcEndPoint,
    arcPreviewPoint
  );
  handlesLayer.append(createSvgElement("path", {
    d: getArcPathData(arcStartPoint, arcEndPoint, controlPoint),
    class: "pen-preview"
  }));
  handlesLayer.append(createSvgElement("line", {
    x1: (arcStartPoint.x + arcEndPoint.x) / 2,
    y1: (arcStartPoint.y + arcEndPoint.y) / 2,
    x2: controlPoint.x,
    y2: controlPoint.y,
    class: "arc-control-guide"
  }));
  [arcStartPoint, arcEndPoint, controlPoint].forEach((draftPoint) => {
    handlesLayer.append(createSvgElement("circle", {
      cx: draftPoint.x,
      cy: draftPoint.y,
      r: 4.5,
      class: "draft-point"
    }));
  });
}

function cancelLine() {
  lineStartPoint = null;
  linePreviewPoint = null;
  lineStartSnap = null;
  handlesLayer.replaceChildren();
}

function renderLineDraft() {
  handlesLayer.replaceChildren();
  if (!lineStartPoint) {
    return;
  }

  const previewPoint = linePreviewPoint || lineStartPoint;
  const snap = findSnapPoint(previewPoint);
  const displayedPoint = snap ? snap.point : previewPoint;
  handlesLayer.append(
    createSvgElement("line", {
      x1: lineStartPoint.x,
      y1: lineStartPoint.y,
      x2: displayedPoint.x,
      y2: displayedPoint.y,
      class: "pen-preview"
    }),
    createSvgElement("circle", {
      cx: lineStartPoint.x,
      cy: lineStartPoint.y,
      r: 5,
      class: "draft-point"
    })
  );

  if (snap) {
    handlesLayer.append(createSvgElement("circle", {
      cx: snap.point.x,
      cy: snap.point.y,
      r: 6,
      class: "draft-point snap-ready"
    }));
  }
  renderSnapVertices(snap);
}

function getPolygonPoints(center, sides, radius) {
  const points = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / sides;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius
    });
  }
  return points;
}

function pointsToAttribute(points) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

function removeDuplicateClosingPoint(points) {
  const cleanPoints = points.map((point) => ({ x: point.x, y: point.y }));
  if (cleanPoints.length > 1
    && distance(cleanPoints[0], cleanPoints[cleanPoints.length - 1]) < 0.01) {
    cleanPoints.pop();
  }
  return cleanPoints;
}

function createPenPath(points, closed = false) {
  const storedPoints = closed ? removeDuplicateClosingPoint(points) : points;
  if (storedPoints.length < 2) {
    return null;
  }

  const path = createSvgElement(closed ? "polygon" : "polyline", {
    points: pointsToAttribute(storedPoints)
  });
  path.dataset.kind = "pen";
  if (closed) {
    path.dataset.closed = "true";
  }
  applyDefaultStyle(path);
  return path;
}

function replaceWithPenPathElement(shape, points, closed) {
  const path = createPenPath(points, closed);
  if (!path) {
    return null;
  }

  ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"].forEach((name) => {
    const value = shape.getAttribute(name);
    if (value !== null) {
      path.setAttribute(name, value);
    }
  });
  path.classList.add("drawable");
  drawingLayer.insertBefore(path, shape);
  shape.remove();
  return path;
}

function normalizeClosedPenStorage() {
  [...drawingLayer.children].forEach((shape) => {
    if (shape.dataset.kind !== "pen" || shape.dataset.closed !== "true") {
      return;
    }

    const points = getElementPoints(shape);
    const storedPoints = removeDuplicateClosingPoint(points);
    const isAlreadyNormalized = shape.tagName.toLowerCase() === "polygon"
      && storedPoints.length === points.length;

    if (!isAlreadyNormalized) {
      replaceWithPenPathElement(shape, storedPoints, true);
    }
  });
}

function getElementPoints(element) {
  return [...element.points].map((point) => ({ x: point.x, y: point.y }));
}

function createPolygon(point) {
  const sides = clamp(Number.parseInt(sidesInput.value, 10) || 5, 3, 12);
  sidesInput.value = sides;
  const radius = 50;
  const center = {
    x: clamp(point.x, radius + EDGE_MARGIN, WORKSPACE_SIZE - radius - EDGE_MARGIN),
    y: clamp(point.y, radius + EDGE_MARGIN, WORKSPACE_SIZE - radius - EDGE_MARGIN)
  };
  const polygon = createSvgElement("polygon", {
    points: pointsToAttribute(getPolygonPoints(center, sides, radius))
  });
  polygon.dataset.kind = "polygon";
  appendAndSelect(polygon);
}

function getPenSnap(point, canClose = false) {
  const points = penShape?._drawingPoints || [];
  const closeCandidate = canClose && points.length >= 3
    ? [{
      point: points[0],
      type: "close",
      shape: penShape,
      vertexIndex: 0
    }]
    : [];
  return findSnapPointIncludingSegments(
    point,
    penShape,
    closeCandidate,
    null
  );
}

function materializePenSegmentSnap(snap) {
  if (snap?.type !== "segment" || !snap.shape) {
    return snap;
  }
  const replacement = insertTopologyPointOnSegment(
    snap.shape,
    snap.segmentIndex,
    snap.point
  );
  if (!replacement) {
    return snap;
  }
  return {
    point: { ...snap.point },
    type: "vertex",
    shape: replacement,
    vertexIndex: snap.segmentIndex + 1,
    distance: snap.distance
  };
}

function beginPenPath(point) {
  const snap = materializePenSegmentSnap(getPenSnap(point));
  const startPoint = snap ? { ...snap.point } : point;
  penShape = createSvgElement("polyline", { points: pointsToAttribute([startPoint]) });
  penShape.dataset.kind = "pen";
  penShape._drawingPoints = [startPoint];
  penPreviewPoint = startPoint;
  penStartSnap = snap;
  penEndSnap = snap;
  applyDefaultStyle(penShape);
  drawingLayer.append(penShape);
  selectShape(null);
  renderPenDraft();
}

function addPenPoint(point) {
  const points = penShape._drawingPoints;
  const canClose = points.length >= 3;
  const snap = materializePenSegmentSnap(getPenSnap(point, canClose));
  const resolvedPoint = snap ? { ...snap.point } : point;
  const shouldClose = snap?.type === "close";

  if (shouldClose) {
    points.push({ ...points[0] });
    penShape.dataset.closed = "true";
    penShape.setAttribute("points", pointsToAttribute(points));
    finishPenPath();
    return;
  }

  if (distance(points[points.length - 1], resolvedPoint) >= 2) {
    points.push(resolvedPoint);
    penPreviewPoint = resolvedPoint;

    penEndSnap = snap;
    penShape.setAttribute("points", pointsToAttribute(points));
    renderPenDraft();
  }
}

function renderPenDraft() {
  handlesLayer.replaceChildren();
  const points = penShape._drawingPoints;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const previewPoint = penPreviewPoint || lastPoint;
  const canClose = points.length >= 3;
  const snap = getPenSnap(previewPoint, canClose);
  const isSnapReady = snap?.type === "close";
  const displayedPreviewPoint = snap ? snap.point : previewPoint;

  if (points.length && distance(lastPoint, displayedPreviewPoint) > 0) {
    handlesLayer.append(createSvgElement("line", {
      x1: lastPoint.x,
      y1: lastPoint.y,
      x2: displayedPreviewPoint.x,
      y2: displayedPreviewPoint.y,
      class: "pen-preview"
    }));
  }

  penShape._drawingPoints.forEach((point, index) => {
    const marker = createSvgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: index === 0 ? 6 : 4,
      class: index === 0
        ? `draft-point snap-point${isSnapReady ? " snap-ready" : ""}`
        : "draft-point"
    });
    handlesLayer.append(marker);
  });

  if (snap && snap.type !== "close") {
    handlesLayer.append(createSvgElement("circle", {
      cx: snap.point.x,
      cy: snap.point.y,
      r: 6,
      class: "draft-point snap-ready"
    }));
  }
  renderSnapVertices(snap, penShape);
}

function finishPenPath() {
  if (!penShape) {
    return;
  }

  const completedShape = penShape;
  const points = completedShape._drawingPoints;
  const wasClosed = completedShape.dataset.closed === "true";
  penShape = null;
  penPreviewPoint = null;
  delete completedShape._drawingPoints;

  if (points.length < 2 || getPointsExtent(points) < MIN_SIZE) {
    completedShape.remove();
    penStartSnap = null;
    penEndSnap = null;
    selectShape(null);
    return;
  }

  const startSnap = penStartSnap;
  const endSnap = penEndSnap;
  const mergedShape = wasClosed
    ? null
    : mergeConnectedPath(points, startSnap, endSnap, completedShape);
  let finalShape = mergedShape || completedShape;
  if (wasClosed && finalShape?.dataset.kind === "pen") {
    finalShape = replaceWithPenPath(finalShape, getElementPoints(finalShape), true);
  }
  let convertedRectangle = false;
  const rectangleConnections = [
    { snap: endSnap, pointIndex: getElementPoints(finalShape).length - 1 },
    { snap: startSnap, pointIndex: 0 }
  ];
  rectangleConnections.forEach(({ snap, pointIndex }) => {
    if (snap?.type !== "vertex"
      || snap.shape?.dataset.kind !== "rect"
      || !drawingLayer.contains(snap.shape)) {
      return;
    }
    const joinedShape = mergeClosedShapeIntoPen(
      finalShape,
      pointIndex,
      snap.shape,
      snap.vertexIndex
    );
    if (joinedShape) {
      finalShape = joinedShape;
      convertedRectangle = true;
    }
  });
  penStartSnap = null;
  penEndSnap = null;
  selectShape(finalShape);
  recordHistory();
  setActiveTool("select");
}

function cancelPenPath() {
  if (!penShape) {
    return;
  }
  penShape.remove();
  penShape = null;
  penPreviewPoint = null;
  penStartSnap = null;
  penEndSnap = null;
  selectShape(null);
}

function beginPencilPath(point, pointerId) {
  const snap = findSnapPoint(point);
  const startPoint = snap ? { ...snap.point } : point;
  const snappedPencilPoints = snap?.shape?.dataset.kind === "pencil"
    && snap.shape.dataset.closed !== "true"
    && (snap.vertexIndex === 0
      || snap.vertexIndex === getElementPoints(snap.shape).length - 1)
    ? getElementPoints(snap.shape)
    : null;
  const drawingPoints = snappedPencilPoints
    ? snap.vertexIndex === 0
      ? [...snappedPencilPoints].reverse()
      : snappedPencilPoints
    : [startPoint];

  pencilShape = createSvgElement("polyline", {
    points: pointsToAttribute(drawingPoints)
  });
  pencilShape.dataset.kind = "pencil";
  pencilShape._drawingPoints = drawingPoints.map((item) => ({ ...item }));
  pencilShape._extensionStartIndex = snappedPencilPoints
    ? drawingPoints.length - 1
    : null;
  pencilStartSnap = snappedPencilPoints ? null : snap;

  if (snappedPencilPoints) {
    copyPencilAppearance(snap.shape, pencilShape);
    drawingLayer.insertBefore(pencilShape, snap.shape);
    snap.shape.remove();
  } else {
    applyDefaultStyle(pencilShape);
    drawingLayer.append(pencilShape);
  }
  workspace.setPointerCapture(pointerId);
  selectShape(null);
  renderSnapVertices(snap);
}

function continuePencilPath(point) {
  const points = pencilShape._drawingPoints;

  if (points.length === 1
    && pencilStartSnap
    && distance(point, pencilStartSnap.point) <= getSnapDistance()) {
    return;
  }

  if (distance(points[points.length - 1], point) >= PENCIL_SAMPLE_DISTANCE) {
    points.push(point);
    pencilShape.setAttribute("points", pointsToAttribute(points));
  }
}

function getPointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return distance(point, start);
  }

  const amount = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy),
    0,
    1
  );
  return distance(point, {
    x: start.x + dx * amount,
    y: start.y + dy * amount
  });
}

function getPolylineLength(points) {
  let totalLength = 0;
  for (let index = 1; index < points.length; index += 1) {
    totalLength += distance(points[index - 1], points[index]);
  }
  return totalLength;
}

function getPencilSimplifyTolerance(points) {
  return clamp(
    getPolylineLength(points) / 220,
    PENCIL_MIN_TOLERANCE,
    PENCIL_MAX_TOLERANCE
  );
}

function simplifyPencilPoints(points, tolerance) {
  if (points.length <= 2) {
    return points.map((point) => ({ ...point }));
  }

  let furthestDistance = 0;
  let furthestIndex = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let index = 1; index < points.length - 1; index += 1) {
    const currentDistance = getPointSegmentDistance(points[index], start, end);
    if (currentDistance > furthestDistance) {
      furthestDistance = currentDistance;
      furthestIndex = index;
    }
  }

  if (furthestDistance <= tolerance) {
    return [{ ...start }, { ...end }];
  }

  const firstPart = simplifyPencilPoints(points.slice(0, furthestIndex + 1), tolerance);
  const secondPart = simplifyPencilPoints(points.slice(furthestIndex), tolerance);
  return [...firstPart.slice(0, -1), ...secondPart];
}

function finishPencilPath(releasePoint = null) {
  if (!pencilShape) {
    return;
  }

  const completedShape = pencilShape;
  let points = completedShape._drawingPoints;
  const extensionStartIndex = completedShape._extensionStartIndex;
  const finalPointerPoint = releasePoint || points[points.length - 1];
  const canClose = points.length >= 3
    && getPointsExtent(points) >= MIN_SIZE;
  const endSnap = findSnapPoint(
    finalPointerPoint,
    completedShape,
    canClose
      ? [{
        point: points[0],
        type: "pencil-close",
        shape: completedShape,
        vertexIndex: 0
      }]
      : []
  );
  const resolvedEndPoint = endSnap
    ? { ...endSnap.point }
    : { ...finalPointerPoint };

  if (points.length === 1 || distance(points[points.length - 1], resolvedEndPoint) >= 0.5) {
    points.push(resolvedEndPoint);
  } else {
    points[points.length - 1] = resolvedEndPoint;
  }

  if (endSnap) {
    completedShape.setAttribute("points", pointsToAttribute(points));
  }
  if (extensionStartIndex !== null) {
    const originalPart = points.slice(0, extensionStartIndex);
    const extensionPart = points.slice(extensionStartIndex);
    const simplifiedExtension = simplifyPencilPoints(
      extensionPart,
      getPencilSimplifyTolerance(extensionPart)
    );
    points = [...originalPart, ...simplifiedExtension];
  } else {
    points = simplifyPencilPoints(points, getPencilSimplifyTolerance(points));
  }
  const wasClosed = endSnap?.type === "pencil-close";
  if (wasClosed) {
    points[points.length - 1] = { ...points[0] };
    completedShape.dataset.closed = "true";
  }
  completedShape.setAttribute("points", pointsToAttribute(points));
  pencilShape = null;
  delete completedShape._drawingPoints;
  delete completedShape._extensionStartIndex;

  if (points.length < 2 || getPointsExtent(points) < MIN_SIZE) {
    completedShape.remove();
    pencilStartSnap = null;
    selectShape(null);
    return;
  }

  pencilStartSnap = null;
  selectShape(completedShape);
  recordHistory();
  setActiveTool("select");
}

function getPointsExtent(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function densifyPolyline(points, spacing = ERASER_SAMPLE_SPACING) {
  if (points.length < 2) {
    return points.map((point) => ({ ...point }));
  }

  const densePoints = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = distance(start, end);
    const steps = Math.max(1, Math.ceil(segmentLength / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      densePoints.push({
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount
      });
    }
  }
  return densePoints;
}

function splitPencilByEraser(points, eraserStart, eraserEnd, isClosed = false) {
  const densePoints = densifyPolyline(points);
  const parts = [];
  let currentPart = [];
  let erasedAnyPoint = false;

  densePoints.forEach((point) => {
    const isErased = getPointSegmentDistance(point, eraserStart, eraserEnd)
      <= ERASER_RADIUS;
    if (isErased) {
      erasedAnyPoint = true;
      if (currentPart.length > 1) {
        parts.push(currentPart);
      }
      currentPart = [];
    } else {
      currentPart.push(point);
    }
  });

  if (currentPart.length > 1) {
    parts.push(currentPart);
  }
  if (erasedAnyPoint
    && isClosed
    && parts.length > 1
    && getPointSegmentDistance(densePoints[0], eraserStart, eraserEnd) > ERASER_RADIUS
    && getPointSegmentDistance(
      densePoints[densePoints.length - 1],
      eraserStart,
      eraserEnd
    ) > ERASER_RADIUS) {
    const firstPart = parts.shift();
    const lastPart = parts.pop();
    parts.unshift([...lastPart, ...firstPart.slice(1)]);
  }
  return erasedAnyPoint ? parts : null;
}

function copyPencilAppearance(source, target) {
  ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"]
    .forEach((attribute) => {
      if (source.hasAttribute(attribute)) {
        target.setAttribute(attribute, source.getAttribute(attribute));
      }
    });
}

function erasePencilSegment(eraserStart, eraserEnd) {
  let changed = false;
  [...drawingLayer.children].forEach((shape) => {
    if (shape.dataset.kind !== "pencil") {
      return;
    }

    const parts = splitPencilByEraser(
      getElementPoints(shape),
      eraserStart,
      eraserEnd,
      shape.dataset.closed === "true"
    );
    if (!parts) {
      return;
    }

    changed = true;
    const insertionPoint = shape.nextSibling;
    shape.remove();
    parts.forEach((points) => {
      if (getPointsExtent(points) < 2) {
        return;
      }
      const part = createOpenPath(points);
      if (part) {
        part.dataset.kind = "pencil";
        copyPencilAppearance(shape, part);
        drawingLayer.insertBefore(part, insertionPoint);
      }
    });
  });
  return changed;
}

function renderEraserPreview(point) {
  handlesLayer.replaceChildren(createSvgElement("circle", {
    cx: point.x,
    cy: point.y,
    r: ERASER_RADIUS,
    class: "eraser-preview"
  }));
}

function addHandle(x, y, type, index = "", sourceShape = selectedShape) {
  const isMoveHandle = type === "move" || type === "group-move";
  if (isMoveHandle) {
    const target = createSvgElement("circle", {
      cx: x,
      cy: y,
      r: 9,
      fill: "transparent",
      stroke: "transparent",
      "data-handle": type,
      "data-index": index,
      "data-shape-source": sourceShape
        ? [...drawingLayer.children].indexOf(sourceShape)
        : ""
    });
    const ring = createSvgElement("circle", {
      cx: x,
      cy: y,
      r: 8,
      class: "move-handle-ring"
    });
    const center = createSvgElement("circle", {
      cx: x,
      cy: y,
      r: 3.5,
      class: "move-handle-center"
    });
    handlesLayer.append(target, ring, center);
    return;
  }

  if (type === "arc-bend") {
    handlesLayer.append(createSvgElement("circle", {
      cx: x,
      cy: y,
      r: 9,
      class: "arc-bend-halo"
    }));
  }

  const handleAttributes = {
    cx: x,
    cy: y,
    "data-handle": type,
    "data-index": index,
    "data-shape-source": sourceShape
      ? [...drawingLayer.children].indexOf(sourceShape)
      : ""
  };
  const hitTarget = createSvgElement("circle", {
    ...handleAttributes,
    r: 9 / canvasZoom,
    class: "vertex-handle-target"
  });
  const handle = createSvgElement("circle", {
    ...handleAttributes,
    r: 4.5
  });
  handle.classList.add("handle", "resize-handle");
  const isEditablePoint = type === "pen-point"
    || type === "polygon-vertex"
    || type === "rect-vertex"
    || type === "arc-point"
    || type === "pencil-end";
  if (isEditablePoint
    && sourceShape === selectedShape
    && Number(index) === selectedPenPointIndex) {
    handle.classList.add("selected-point");
  }
  handlesLayer.append(hitTarget, handle);
}

function renderConnectedComponentNodeHandles() {
  selectedShapes.forEach((shape) => {
    const kind = shape.dataset.kind;
    if (kind === "pen") {
      getElementPoints(shape).forEach((point, index) => {
        addHandle(point.x, point.y, "pen-point", index, shape);
      });
    } else if (kind === "polygon") {
      getElementPoints(shape).forEach((point, index) => {
        addHandle(point.x, point.y, "polygon-vertex", index, shape);
      });
    } else if (kind === "line") {
      getShapeVertices(shape).forEach((point, index) => {
        addHandle(point.x, point.y, "line-end", index, shape);
      });
    } else if (kind === "arc") {
      const data = getArcData(shape);
      if (data) {
        addHandle(data.start.x, data.start.y, "arc-point", 0, shape);
        addHandle(data.end.x, data.end.y, "arc-point", 1, shape);
      }
    } else if (kind === "rect") {
      getShapeVertices(shape).forEach((point, index) => {
        addHandle(point.x, point.y, "rect-vertex", index, shape);
      });
    }
  });
}

function getClosestPointOnSegment(point, first, second, minimumAmount = 0, maximumAmount = 1) {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared < 0.01) {
    return { ...first };
  }

  const amount = clamp(
    ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared,
    minimumAmount,
    maximumAmount
  );

  return {
    x: first.x + dx * amount,
    y: first.y + dy * amount
  };
}

function getArcHeightHandleData(shape, bendPoint) {
  const data = getArcData(shape);

  if (!data || !bendPoint) {
    return {
      point: bendPoint,
      angle: 0
    };
  }

  const midpoint = {
    x: (data.start.x + data.end.x) / 2,
    y: (data.start.y + data.end.y) / 2
  };

  let direction = {
    x: bendPoint.x - midpoint.x,
    y: bendPoint.y - midpoint.y
  };

  let directionLength = Math.hypot(direction.x, direction.y);

  if (directionLength < 0.01) {
    const chordLength = distance(data.start, data.end);

    if (chordLength < 0.01) {
      return {
        point: { ...bendPoint },
        angle: 0
      };
    }

    direction = {
      x: -(data.end.y - data.start.y) / chordLength,
      y: (data.end.x - data.start.x) / chordLength
    };
    directionLength = 1;
  }

  if (selectedShapes.length > 1 && selectedShapes.includes(shape)) {
    const offset = 22 / canvasZoom;

    return {
      point: {
        x: bendPoint.x + (direction.x / directionLength) * offset,
        y: bendPoint.y + (direction.y / directionLength) * offset
      },
      angle: Math.atan2(
        data.end.y - data.start.y,
        data.end.x - data.start.x
      ) * 180 / Math.PI
    };
  }

  const frame = getArcFrame(shape);
  const side = frame.map((point, index) => {
    const nextPoint = frame[(index + 1) % frame.length];
    const center = {
      x: (point.x + nextPoint.x) / 2,
      y: (point.y + nextPoint.y) / 2
    };

    return {
      start: point,
      end: nextPoint,
      center,
      score: (
        (center.x - midpoint.x) * direction.x
        + (center.y - midpoint.y) * direction.y
      )
    };
  }).reduce((bestSide, sideItem) =>
    sideItem.score > bestSide.score ? sideItem : bestSide
  );

  return {
    point: getClosestPointOnSegment(bendPoint, side.start, side.end, 0.12, 0.88),
    angle: Math.atan2(
      side.end.y - side.start.y,
      side.end.x - side.start.x
    ) * 180 / Math.PI
  };
}

function addArcHeightHandle(sourceShape, bendPoint) {
  if (!sourceShape || !bendPoint) {
    return;
  }

  const control = getArcHeightHandleData(sourceShape, bendPoint);
  const handleSize = 11 / canvasZoom;

  handlesLayer.append(createSvgElement("rect", {
    x: control.point.x - handleSize / 2,
    y: control.point.y - handleSize / 2,
    width: handleSize,
    height: handleSize,
    rx: 1.5 / canvasZoom,
    class: "arc-height-handle",
    transform: `rotate(${control.angle} ${control.point.x} ${control.point.y})`,
    "data-handle": "arc-height",
    "data-shape-source": [...drawingLayer.children].indexOf(sourceShape)
  }));
}

function renderFocusedArcControls() {
  if (selectedShape?.dataset.kind !== "arc") {
    return;
  }
  const data = getArcData(selectedShape);
  if (!data) {
    return;
  }
  const displayedThrough = getDisplayedArcControlPoint(
    data.start,
    data.end,
    data.through,
    getArcStretch(selectedShape),
    getArcWidth(selectedShape)
  );
  handlesLayer.append(createSvgElement("line", {
    x1: (data.start.x + data.end.x) / 2,
    y1: (data.start.y + data.end.y) / 2,
    x2: displayedThrough.x,
    y2: displayedThrough.y,
    class: "arc-control-guide"
  }));
  addHandle(
    displayedThrough.x,
    displayedThrough.y,
    "arc-bend",
    2,
    selectedShape
  );

  addArcHeightHandle(selectedShape, displayedThrough);
}

function getOpenPenSnapTargetIndex() {
  if (!selectedShape
    || selectedShape.dataset.kind !== "pen"
    || selectedShape.dataset.closed === "true"
    || !dragState
    || dragState.type !== "pen-point") {
    return null;
  }

  const points = getElementPoints(selectedShape);
  if (points.length < 3) {
    return null;
  }
  const lastIndex = points.length - 1;
  if (dragState.index !== 0 && dragState.index !== lastIndex) {
    return null;
  }

  const oppositeIndex = dragState.index === 0 ? lastIndex : 0;
  return distance(points[dragState.index], points[oppositeIndex]) <= getSnapDistance()
    ? oppositeIndex
    : null;
}

function getPolygonCentroid(points) {
  const uniquePoints = points.length > 1
    && distance(points[0], points[points.length - 1]) < 0.01
    ? points.slice(0, -1)
    : points;
  let signedArea = 0;
  let centerX = 0;
  let centerY = 0;

  uniquePoints.forEach((point, index) => {
    const nextPoint = uniquePoints[(index + 1) % uniquePoints.length];
    const cross = point.x * nextPoint.y - nextPoint.x * point.y;
    signedArea += cross;
    centerX += (point.x + nextPoint.x) * cross;
    centerY += (point.y + nextPoint.y) * cross;
  });

  signedArea *= 0.5;
  if (Math.abs(signedArea) < 0.01) {
    return null;
  }

  return {
    x: centerX / (6 * signedArea),
    y: centerY / (6 * signedArea)
  };
}

function getPolylineCenter(points) {
  let totalLength = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const segmentLength = distance(points[index], points[index + 1]);
    totalLength += segmentLength;
    weightedX += ((points[index].x + points[index + 1].x) / 2) * segmentLength;
    weightedY += ((points[index].y + points[index + 1].y) / 2) * segmentLength;
  }

  if (totalLength < 0.01) {
    return points[0] || { x: WORKSPACE_SIZE / 2, y: WORKSPACE_SIZE / 2 };
  }

  return {
    x: weightedX / totalLength,
    y: weightedY / totalLength
  };
}

function getShapeRotationCenter(shape) {
  const kind = shape.dataset.kind;

  if (kind === "ellipse") {
    return {
      x: Number(shape.getAttribute("cx")),
      y: Number(shape.getAttribute("cy"))
    };
  }

  if (kind === "arc") {
    return getFrameCenter(getArcFrame(shape));
  }

  if (kind === "polygon" || kind === "pen" || kind === "pencil") {
    return getFrameCenter(getSelectionFrame(shape));
  }

  if (kind === "line") {
    return {
      x: (Number(shape.getAttribute("x1")) + Number(shape.getAttribute("x2"))) / 2,
      y: (Number(shape.getAttribute("y1")) + Number(shape.getAttribute("y2"))) / 2
    };
  }

  const box = shape.getBBox();
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2
  };
}

function getMoveHandlePoint(shape) {
  return getShapeRotationCenter(shape);
}

function rotatePoint(point, center, angleDegrees) {
  const angle = angleDegrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine
  };
}

function getSelectionFrame(shape) {
  if (shape.dataset.selectionFrame) {
    try {
      return JSON.parse(shape.dataset.selectionFrame);
    } catch {
      shape.removeAttribute("data-selection-frame");
    }
  }

  const box = shape.getBBox();
  const padding = ["polygon", "pen", "pencil"].includes(shape.dataset.kind)
    && shape.dataset.rectangle !== "true"
    ? 10
    : 0;
  return [
    { x: box.x - padding, y: box.y - padding },
    { x: box.x + box.width + padding, y: box.y - padding },
    { x: box.x + box.width + padding, y: box.y + box.height + padding },
    { x: box.x - padding, y: box.y + box.height + padding }
  ];
}

function setSelectionFrame(shape, frame) {
  shape.dataset.selectionFrame = JSON.stringify(frame);
}

function getFrameCenter(frame) {
  return {
    x: frame.reduce((sum, point) => sum + point.x, 0) / frame.length,
    y: frame.reduce((sum, point) => sum + point.y, 0) / frame.length
  };
}

function pointsAreInsideWorkspace(points) {
  return points.every((point) => (
    point.x >= EDGE_MARGIN
    && point.x <= WORKSPACE_SIZE - EDGE_MARGIN
    && point.y >= EDGE_MARGIN
    && point.y <= WORKSPACE_SIZE - EDGE_MARGIN
  ));
}

function getTextRotation(textElement) {
  return Number(textElement.dataset.rotation || 0);
}

function getEllipseRotation(ellipse) {
  return Number(ellipse.dataset.rotation || 0);
}

function applyEllipseRotation(ellipse) {
  const angle = getEllipseRotation(ellipse);
  if (!angle) {
    ellipse.removeAttribute("transform");
    return;
  }
  const cx = Number(ellipse.getAttribute("cx"));
  const cy = Number(ellipse.getAttribute("cy"));
  ellipse.setAttribute("transform", `rotate(${angle} ${cx} ${cy})`);
}

function getEllipseCardinalPoints(ellipse, angle = getEllipseRotation(ellipse)) {
  const cx = Number(ellipse.getAttribute("cx"));
  const cy = Number(ellipse.getAttribute("cy"));
  const radiusX = Number(ellipse.getAttribute("rx"));
  const radiusY = Number(ellipse.getAttribute("ry"));
  const center = { x: cx, y: cy };
  return [
    { x: cx + radiusX, y: cy },
    { x: cx, y: cy + radiusY },
    { x: cx - radiusX, y: cy },
    { x: cx, y: cy - radiusY }
  ].map((point) => rotatePoint(point, center, angle));
}

function getEllipseFrame(ellipse, angle = getEllipseRotation(ellipse)) {
  const cx = Number(ellipse.getAttribute("cx"));
  const cy = Number(ellipse.getAttribute("cy"));
  const radiusX = Number(ellipse.getAttribute("rx"));
  const radiusY = Number(ellipse.getAttribute("ry"));
  const center = { x: cx, y: cy };
  return [
    { x: cx - radiusX, y: cy - radiusY },
    { x: cx + radiusX, y: cy - radiusY },
    { x: cx + radiusX, y: cy + radiusY },
    { x: cx - radiusX, y: cy + radiusY }
  ].map((point) => rotatePoint(point, center, angle));
}

function getEllipseBounds(ellipse, angle = getEllipseRotation(ellipse)) {
  const cx = Number(ellipse.getAttribute("cx"));
  const cy = Number(ellipse.getAttribute("cy"));
  const radiusX = Number(ellipse.getAttribute("rx"));
  const radiusY = Number(ellipse.getAttribute("ry"));
  const radians = angle * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const extentX = Math.hypot(radiusX * cosine, radiusY * sine);
  const extentY = Math.hypot(radiusX * sine, radiusY * cosine);
  return {
    x: cx - extentX,
    y: cy - extentY,
    width: extentX * 2,
    height: extentY * 2
  };
}

function ellipseIsInsideWorkspace(ellipse, angle = getEllipseRotation(ellipse)) {
  const bounds = getEllipseBounds(ellipse, angle);
  return bounds.x >= EDGE_MARGIN
    && bounds.y >= EDGE_MARGIN
    && bounds.x + bounds.width <= WORKSPACE_SIZE - EDGE_MARGIN
    && bounds.y + bounds.height <= WORKSPACE_SIZE - EDGE_MARGIN;
}

function applyTextRotation(textElement) {
  const angle = getTextRotation(textElement);
  if (!angle) {
    textElement.removeAttribute("transform");
    return;
  }
  const box = textElement.getBBox();
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  textElement.setAttribute("transform", `rotate(${angle} ${centerX} ${centerY})`);
}

function getTextRotatedCorners(textElement, angle = getTextRotation(textElement)) {
  const box = textElement.getBBox();
  const center = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2
  };
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ].map((point) => rotatePoint(point, center, angle));
}

function rotateSelectedShape(angle, saveHistory = true, centerOverride = null) {
  if (!selectedShape) {
    return;
  }

  const kind = selectedShape.dataset.kind;
  if (kind === "circle") {
    return;
  }

  if (kind === "ellipse") {
    const nextAngle = (getEllipseRotation(selectedShape) + angle + 360) % 360;
    if (!ellipseIsInsideWorkspace(selectedShape, nextAngle)) {
      return;
    }
    selectedShape.dataset.rotation = nextAngle;
    applyEllipseRotation(selectedShape);
    renderHandles();
    if (saveHistory) {
      recordHistory();
    }
    return;
  }

  if (kind === "text") {
    const previousAngle = getTextRotation(selectedShape);
    const nextAngle = (previousAngle + angle + 360) % 360;
    if (!pointsAreInsideWorkspace(getTextRotatedCorners(selectedShape, nextAngle))) {
      return;
    }
    selectedShape.dataset.rotation = nextAngle;
    applyTextRotation(selectedShape);
    renderHandles();
    if (saveHistory) {
      recordHistory();
    }
    return;
  }

  const center = centerOverride || getMoveHandlePoint(selectedShape);
  if (kind === "rect") {
    const x = Number(selectedShape.getAttribute("x"));
    const y = Number(selectedShape.getAttribute("y"));
    const width = Number(selectedShape.getAttribute("width"));
    const height = Number(selectedShape.getAttribute("height"));
    const corners = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ].map((point) => rotatePoint(point, center, angle));
    if (!pointsAreInsideWorkspace(corners)) {
      return;
    }
    const closedPoints = [...corners, { ...corners[0] }];
    selectedShape = replaceWithPenPath(selectedShape, closedPoints, true);
    selectedShapes = [selectedShape];
    selectedShape.dataset.rectangle = "true";
    setSelectionFrame(selectedShape, corners);
  } else if (kind === "line") {
    const points = getShapeVertices(selectedShape)
      .map((point) => rotatePoint(point, center, angle));
    if (!pointsAreInsideWorkspace(points)) {
      return;
    }
    selectedShape.setAttribute("x1", points[0].x);
    selectedShape.setAttribute("y1", points[0].y);
    selectedShape.setAttribute("x2", points[1].x);
    selectedShape.setAttribute("y2", points[1].y);
  } else if (kind === "arc") {
    const data = getArcData(selectedShape);
    const points = [data.start, data.end, data.through]
      .map((point) => rotatePoint(point, center, angle));
    if (!isArcInsideWorkspace(
      points[0],
      points[1],
      points[2],
      getArcStretch(selectedShape),
      getArcWidth(selectedShape)
    )) {
      return;
    }
    setArcData(selectedShape, points[0], points[1], points[2]);
  } else if (kind === "polygon" || kind === "pen" || kind === "pencil") {
    const currentFrame = getSelectionFrame(selectedShape);
    const points = getElementPoints(selectedShape)
      .map((point) => rotatePoint(point, center, angle));
    if (!pointsAreInsideWorkspace(points)) {
      return;
    }
    selectedShape.setAttribute("points", pointsToAttribute(points));
    const frame = currentFrame
      .map((point) => rotatePoint(point, center, angle));
    setSelectionFrame(selectedShape, frame);
  } else {
    return;
  }

  selectedPenPointIndex = null;
  propagateShapeTopologyLinks(selectedShape);
  renderHandles();
  if (saveHistory) {
    recordHistory();
  }
}

function renderHandles() {
  if (activeTool === "measure") {
    renderMeasurementControls();
    return;
  }
  renderSelectionInteractionLayer();
  handlesLayer.replaceChildren();

  if (selectedShapes.length > 1) {
    const frame = groupSelectionFrame;
    const center = getFrameCenter(frame);
    handlesLayer.append(createSvgElement("polygon", {
      points: pointsToAttribute(frame),
      class: "selection-bounds group-selection-bounds"
    }));
    addScaleHandles(frame, "group-scale", null);
    addHandle(
      center.x,
      center.y,
      "group-move"
    );
    addRotationControl(frame);
    renderConnectedComponentNodeHandles();
    renderFocusedArcControls();
    renderHoveredShapeHandles();
    updateSeparatePointsButton();
    return;
  }

  if (!selectedShape || !drawingLayer.contains(selectedShape)) {
    selectedShape = null;
    selectedShapes = [];
    renderHoveredShapeHandles();
    return;
  }

  const box = selectedShape.getBBox();
  let arcHandles = null;

  if (selectedShape.dataset.kind === "rect") {
    const frame = [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height }
    ];
    addRectangleSideHandles(frame);
    [
      { x: box.x, y: box.y },
      { x: box.x + box.width, y: box.y },
      { x: box.x + box.width, y: box.y + box.height },
      { x: box.x, y: box.y + box.height }
    ].forEach((point, index) => {
      addHandle(point.x, point.y, "rect-vertex", index);
    });
  } else if (selectedShape.dataset.kind === "circle") {
    addHandle(
      Number(selectedShape.getAttribute("cx")) + Number(selectedShape.getAttribute("r")),
      Number(selectedShape.getAttribute("cy")),
      "circle-radius"
    );
  } else if (selectedShape.dataset.kind === "ellipse") {
    getEllipseCardinalPoints(selectedShape).forEach((point, index) => {
      addHandle(point.x, point.y, "ellipse-radius", index);
    });
  } else if (selectedShape.dataset.kind === "arc") {
    const data = getArcData(selectedShape);
    const stretch = getArcStretch(selectedShape);
    const width = getArcWidth(selectedShape);
    const displayedThrough = getDisplayedArcControlPoint(
      data.start,
      data.end,
      data.through,
      stretch,
      width
    );
    handlesLayer.append(createSvgElement("line", {
      x1: (data.start.x + data.end.x) / 2,
      y1: (data.start.y + data.end.y) / 2,
      x2: displayedThrough.x,
      y2: displayedThrough.y,
      class: "arc-control-guide"
    }));
    arcHandles = {
      start: data.start,
      end: data.end,
      bend: displayedThrough
    };
  } else if (selectedShape.dataset.kind === "line") {
    addHandle(
      Number(selectedShape.getAttribute("x1")),
      Number(selectedShape.getAttribute("y1")),
      "line-end",
      0
    );
    addHandle(
      Number(selectedShape.getAttribute("x2")),
      Number(selectedShape.getAttribute("y2")),
      "line-end",
      1
    );
  } else if (selectedShape.dataset.kind === "polygon") {
    getElementPoints(selectedShape).forEach((point, index) => {
      addHandle(point.x, point.y, "polygon-vertex", index);
    });
  } else if (selectedShape.dataset.kind === "pen"
    && selectedShape.dataset.rectangle === "true") {
    const frame = getSelectionFrame(selectedShape);
    addRectangleSideHandles(frame);
    frame.forEach((point, index) => {
      addHandle(point.x, point.y, "rect-vertex", index);
    });
  } else if (selectedShape.dataset.kind === "pen") {
    const snapTargetIndex = getOpenPenSnapTargetIndex();
    getElementPoints(selectedShape).forEach((point, index) => {
      addHandle(point.x, point.y, "pen-point", index);
      if (index === snapTargetIndex) {
        handlesLayer.lastElementChild.classList.add("snap-target");
      }
    });
  } else if (selectedShape.dataset.kind === "pencil") {
    const points = getElementPoints(selectedShape);
    if (selectedShape.dataset.closed !== "true" && points.length > 1) {
      addHandle(points[0].x, points[0].y, "pencil-end", 0);
      addHandle(
        points[points.length - 1].x,
        points[points.length - 1].y,
        "pencil-end",
        points.length - 1
      );
    }
  }

  const moveHandlePoint = getMoveHandlePoint(selectedShape);
  addHandle(moveHandlePoint.x, moveHandlePoint.y, "move");
  addSelectionBoxControls(selectedShape, box);
  if (arcHandles) {
    addHandle(arcHandles.start.x, arcHandles.start.y, "arc-point", 0);
    addHandle(arcHandles.end.x, arcHandles.end.y, "arc-point", 1);
    addHandle(arcHandles.bend.x, arcHandles.bend.y, "arc-bend", 2);
    addArcHeightHandle(selectedShape, arcHandles.bend);
  }
  renderHoveredShapeHandles();
  updateSeparatePointsButton();
}

function addRectangleSideHandles(frame) {
  const angle = Math.atan2(
    frame[1].y - frame[0].y,
    frame[1].x - frame[0].x
  ) * 180 / Math.PI;
  const targetSize = 24 / canvasZoom;
  const targetOffset = targetSize / 2;
  const handleSize = 12 / canvasZoom;
  const handleOffset = handleSize / 2;
  const sides = frame.map((point, index) => {
    const nextPoint = frame[(index + 1) % frame.length];
    return {
      x: (point.x + nextPoint.x) / 2,
      y: (point.y + nextPoint.y) / 2
    };
  });

  sides.forEach((point, index) => {
    handlesLayer.append(
      createSvgElement("rect", {
        x: point.x - targetOffset,
        y: point.y - targetOffset,
        width: targetSize,
        height: targetSize,
        class: "rect-side-target",
        transform: `rotate(${angle} ${point.x} ${point.y})`,
        "data-handle": "rect-side",
        "data-index": index
      }),
      createSvgElement("rect", {
        x: point.x - handleOffset,
        y: point.y - handleOffset,
        width: handleSize,
        height: handleSize,
        rx: 1 / canvasZoom,
        class: "rect-side-handle",
        transform: `rotate(${angle} ${point.x} ${point.y})`
      })
    );
  });
}

function addRotationControl(
  frame,
  anchorOverride = null,
  directionOverride = null,
  spacing = 20
) {
  const corner = anchorOverride || frame[1];
  const center = getFrameCenter(frame);
  const directionX = directionOverride?.x ?? corner.x - center.x;
  const directionY = directionOverride?.y ?? corner.y - center.y;
  const length = Math.hypot(directionX, directionY) || 1;
  const x = clamp(
    corner.x + directionX / length * spacing,
    12,
    WORKSPACE_SIZE - 12
  );
  const y = clamp(
    corner.y + directionY / length * spacing,
    12,
    WORKSPACE_SIZE - 12
  );
  handlesLayer.append(
    createSvgElement("circle", {
      cx: x,
      cy: y,
      r: 11,
      class: "rotate-handle",
      "data-handle": "rotate"
    }),
    createSvgElement("image", {
      x: x - 10,
      y: y - 10,
      width: 20,
      height: 20,
      href: "rotation-arrow.svg",
      class: "rotate-symbol"
    })
  );
}

function addScaleHandles(frame, handleType, shape) {
  const angle = Math.atan2(
    frame[1].y - frame[0].y,
    frame[1].x - frame[0].x
  ) * 180 / Math.PI;
  const shapeIndex = [...drawingLayer.children].indexOf(shape);
  const handleSize = 12 / canvasZoom;
  const handleOffset = handleSize / 2;
  const cornerRadius = 2 / canvasZoom;

  frame.forEach((point, index) => {
    handlesLayer.append(createSvgElement("rect", {
      x: point.x - handleOffset,
      y: point.y - handleOffset,
      width: handleSize,
      height: handleSize,
      rx: cornerRadius,
      class: "scale-handle",
      transform: `rotate(${angle} ${point.x} ${point.y})`,
      "data-handle": handleType,
      "data-index": index,
      "data-shape-source": shapeIndex
    }));
  });
}

function addSelectionBoxControls(shape, box) {
  if (shape.dataset.kind === "circle") {
    return;
  }

  if (shape.dataset.kind === "ellipse") {
    const frame = getEllipseFrame(shape);
    handlesLayer.prepend(createSvgElement("polygon", {
      points: pointsToAttribute(frame),
      class: "selection-bounds"
    }));
    addScaleHandles(frame, "ellipse-scale", shape);
    addRotationControl(frame);
    return;
  }

  if (shape.dataset.kind === "line") {
    const firstPoint = {
      x: Number(shape.getAttribute("x1")),
      y: Number(shape.getAttribute("y1"))
    };
    const secondPoint = {
      x: Number(shape.getAttribute("x2")),
      y: Number(shape.getAttribute("y2"))
    };
    const anchor = secondPoint;
    const dx = secondPoint.x - firstPoint.x;
    const dy = secondPoint.y - firstPoint.y;
    addRotationControl(
      [firstPoint, secondPoint],
      anchor,
      { x: dx, y: dy }
    );
    return;
  }

  if (shape.dataset.kind === "arc") {
    const frame = getArcFrame(shape);
    handlesLayer.prepend(createSvgElement("polygon", {
      points: pointsToAttribute(frame),
      class: "selection-bounds"
    }));
    addScaleHandles(frame, "arc-scale", shape);
    addRotationControl(frame, null, null, 30 / canvasZoom);
    return;
  }

  if (shape.dataset.kind === "text") {
    const frame = getTextRotatedCorners(shape);
    handlesLayer.prepend(createSvgElement("polygon", {
      points: pointsToAttribute(frame),
      class: "selection-bounds"
    }));
    addScaleHandles(frame, "text-scale", shape);
    addRotationControl(frame);
    return;
  }

  if (shape.dataset.rectangle === "true") {
    addRotationControl(getSelectionFrame(shape));
    return;
  }

  const scalableKinds = ["polygon", "pen", "pencil"];
  if (scalableKinds.includes(shape.dataset.kind)) {
    const frame = getSelectionFrame(shape);
    handlesLayer.prepend(createSvgElement("polygon", {
      points: pointsToAttribute(frame),
      class: "selection-bounds"
    }));
    addScaleHandles(frame, "box-scale", shape);
    addRotationControl(frame);
    return;
  }

  const frame = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height }
  ];
  addRotationControl(frame);
}

function updateHoveredShape(target) {
  if (activeTool !== "select" || dragState) {
    return;
  }

  const hitShape = target.closest?.(".selection-hit");
  let nextHoveredShape = null;
  if (hitShape) {
    nextHoveredShape = drawingLayer.children[Number(hitShape.dataset.shapeIndex)] || null;
  } else if (target.closest?.("[data-hover-move]")) {
    nextHoveredShape = hoveredShape;
  }

  if (nextHoveredShape !== hoveredShape) {
    hoveredShape = nextHoveredShape;
    renderHandles();
  }
}

function getSelectedPencilJoinTarget() {
  if (selectedShape?.dataset.kind !== "pencil"
    || selectedShape.dataset.closed === "true"
    || selectedPenPointIndex === null) {
    return null;
  }

  const selectedPoints = getElementPoints(selectedShape);
  const selectedLastIndex = selectedPoints.length - 1;
  if (selectedPenPointIndex !== 0
    && selectedPenPointIndex !== selectedLastIndex) {
    return null;
  }

  const selectedPoint = selectedPoints[selectedPenPointIndex];
  const oppositeIndex = selectedPenPointIndex === 0 ? selectedLastIndex : 0;
  if (distance(selectedPoint, selectedPoints[oppositeIndex]) <= 1.5) {
    return {
      shape: selectedShape,
      endpointIndex: oppositeIndex,
      point: selectedPoints[oppositeIndex],
      distance: distance(selectedPoint, selectedPoints[oppositeIndex])
    };
  }

  let closestTarget = null;
  for (const shape of drawingLayer.children) {
    if (shape === selectedShape || shape.dataset.kind !== "pencil") {
      continue;
    }
    const points = getElementPoints(shape);
    const endpointIndexes = [0, points.length - 1];
    for (const endpointIndex of endpointIndexes) {
      const endpointDistance = distance(selectedPoint, points[endpointIndex]);
      if (endpointDistance <= 1.5
        && (!closestTarget || endpointDistance < closestTarget.distance)) {
        closestTarget = {
          shape,
          endpointIndex,
          point: points[endpointIndex],
          distance: endpointDistance
        };
      }
    }
  }
  return closestTarget;
}

function updateSeparatePointsButton() {
  const data = selectedShape ? getEditablePathData(selectedShape) : null;
  const pencilPoints = selectedShape?.dataset.kind === "pencil"
    ? getElementPoints(selectedShape)
    : null;
  const points = data?.points || pencilPoints || [];
  const hasSelectedPoint = selectedPenPointIndex !== null
    && selectedPenPointIndex >= 0
    && selectedPenPointIndex < points.length;
  const linkedTopologyVertices = getSelectedLinkedTopologyVertices();
  const selectedTopologyPoint = getSelectedTopologyPoint();
  const canSeparateTopology = Boolean(selectedTopologyPoint && linkedTopologyVertices.length);
  const canSeparateClosed = data?.closed === true && hasSelectedPoint;
  const canSeparateOpen = data?.closed === false
    && hasSelectedPoint
    && selectedPenPointIndex > 0
    && selectedPenPointIndex < points.length - 1;
  const canSeparate = canSeparateTopology
    || canSeparateClosed
    || canSeparateOpen;
  const canJoinPencil = Boolean(getSelectedPencilJoinTarget());
  const deleteTarget = getSelectedPointDeleteTarget();
  const canDelete = Boolean(deleteTarget);

  joinPencilButton.hidden = !canJoinPencil;
  separatePointsButton.hidden = !canSeparate;
  deleteSelectedPointButton.hidden = !canDelete;
  pointActions.hidden = !canJoinPencil && !canSeparate && !canDelete;
  if (pointActions.hidden) {
    return;
  }

  const selectedPoint = selectedTopologyPoint?.point
    || points[selectedPenPointIndex];
  if (!selectedPoint) {
    pointActions.hidden = true;
    return;
  }
  const svgPoint = workspace.createSVGPoint();
  svgPoint.x = selectedPoint.x;
  svgPoint.y = selectedPoint.y;
  const screenPoint = svgPoint.matrixTransform(workspace.getScreenCTM());
  const frameBox = workspace.parentElement.getBoundingClientRect();
  pointActions.style.left = `${screenPoint.x - frameBox.left}px`;
  pointActions.style.top = `${screenPoint.y - frameBox.top + 14}px`;
}

function getDeletableSegments(shape) {
  const kind = shape.dataset.kind;

  if (kind === "rect") {
    const x = Number(shape.getAttribute("x"));
    const y = Number(shape.getAttribute("y"));
    const width = Number(shape.getAttribute("width"));
    const height = Number(shape.getAttribute("height"));
    const points = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ];
    return points.map((point, index) => ({
      start: point,
      end: points[(index + 1) % points.length],
      index
    }));
  }

  if (kind === "line") {
    return [{
      start: {
        x: Number(shape.getAttribute("x1")),
        y: Number(shape.getAttribute("y1"))
      },
      end: {
        x: Number(shape.getAttribute("x2")),
        y: Number(shape.getAttribute("y2"))
      },
      index: 0
    }];
  }

  if (kind === "polygon") {
    const points = getElementPoints(shape);
    return points.map((point, index) => ({
      start: point,
      end: points[(index + 1) % points.length],
      index
    }));
  }

  if (kind === "pen") {
    const points = getElementPoints(shape);
    return points.slice(0, -1).map((point, index) => ({
      start: point,
      end: points[index + 1],
      index
    }));
  }

  return [];
}

function renderEdgeDeleteTargets() {
  handlesLayer.replaceChildren();

  [...drawingLayer.children].forEach((shape, shapeIndex) => {
    getDeletableSegments(shape).forEach((segment) => {
      const attributes = {
        x1: segment.start.x,
        y1: segment.start.y,
        x2: segment.end.x,
        y2: segment.end.y
      };
      const target = createSvgElement("line", {
        ...attributes,
        class: "edge-target",
        "data-edge-index": segment.index,
        "data-shape-index": shapeIndex
      });
      const preview = createSvgElement("line", {
        ...attributes,
        class: "edge-preview"
      });
      handlesLayer.append(target, preview);
    });
  });
}

function renderAddPointTargets() {
  handlesLayer.replaceChildren();

  [...drawingLayer.children].forEach((shape, shapeIndex) => {
    getDeletableSegments(shape).forEach((segment) => {
      const attributes = {
        x1: segment.start.x,
        y1: segment.start.y,
        x2: segment.end.x,
        y2: segment.end.y
      };
      const target = createSvgElement("line", {
        ...attributes,
        class: "edge-target",
        "data-add-edge-index": segment.index,
        "data-shape-index": shapeIndex
      });
      const preview = createSvgElement("line", {
        ...attributes,
        class: "edge-preview add-point-preview"
      });
      handlesLayer.append(target, preview);
    });
  });
}

function projectPointOnSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) {
    return { ...start };
  }
  const amount = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    0,
    1
  );
  return {
    x: start.x + dx * amount,
    y: start.y + dy * amount
  };
}

function getTopologyPoints(shape) {
  if (!shape || shape.dataset.kind === "pencil") {
    return [];
  }
  const kind = shape.dataset.kind;
  if (kind === "rect") {
    return getShapeVertices(shape);
  }
  if (kind === "line") {
    return getShapeVertices(shape);
  }
  if (kind === "arc") {
    const data = getArcData(shape);
    return data ? [data.start, data.end] : [];
  }
  if (kind === "polygon" || kind === "pen") {
    const points = getElementPoints(shape);
    if (points.length > 1 && distance(points[0], points[points.length - 1]) < 0.01) {
      points.pop();
    }
    return points;
  }
  return [];
}

function getEditablePointIndexForTopology(shape, topologyIndex) {
  const data = getEditablePathData(shape);
  if (!data || !Number.isInteger(topologyIndex)) {
    return null;
  }
  if (data.closed && topologyIndex === data.points.length - 1) {
    return 0;
  }
  return topologyIndex >= 0 && topologyIndex < data.points.length
    ? topologyIndex
    : null;
}

function normalizeSelectedTopologyIndex(shape, pointIndex = selectedPenPointIndex) {
  if (!shape || pointIndex === null || !Number.isInteger(pointIndex)) {
    return null;
  }
  const topologyPoints = getTopologyPoints(shape);
  if (pointIndex >= 0 && pointIndex < topologyPoints.length) {
    return pointIndex;
  }
  const rawPoints = getElementPoints(shape);
  const closesAtLastPoint = shape.dataset.kind === "pen"
    && shape.dataset.closed === "true"
    && rawPoints.length > 1
    && pointIndex === rawPoints.length - 1
    && topologyPoints.length > 0;
  return closesAtLastPoint ? 0 : null;
}

function getSelectedTopologyPoint() {
  const index = normalizeSelectedTopologyIndex(selectedShape);
  if (index === null) {
    return null;
  }
  const point = getTopologyPoints(selectedShape)[index];
  return point ? { shape: selectedShape, index, point } : null;
}

function getLinkedTopologyVertices(shape, index, point) {
  if (!shape || index === null || !point || isTopologyPointDetached(shape, index)) {
    return [];
  }
  const linked = [];
  [...drawingLayer.children].forEach((candidateShape) => {
    if (candidateShape === shape || candidateShape.dataset.kind === "pencil") {
      return;
    }
    getTopologyPoints(candidateShape).forEach((candidatePoint, candidateIndex) => {
      if (topologyPointsAreConnected(
        shape,
        index,
        point,
        candidateShape,
        candidateIndex,
        candidatePoint
      )) {
        linked.push({ shape: candidateShape, index: candidateIndex, point: candidatePoint });
      }
    });
  });
  return linked;
}

function getSelectedLinkedTopologyVertices() {
  const selectedPoint = getSelectedTopologyPoint();
  return selectedPoint
    ? getLinkedTopologyVertices(
      selectedPoint.shape,
      selectedPoint.index,
      selectedPoint.point
    )
    : [];
}

function canDeletePointFromShape(shape, pointIndex) {
  const data = getEditablePathData(shape);
  const editableIndex = getEditablePointIndexForTopology(shape, pointIndex);
  if (!data || editableIndex === null) {
    return false;
  }
  const uniquePointCount = data.closed
    ? Math.max(0, data.points.length - 1)
    : data.points.length;
  return data.closed
    ? uniquePointCount > 3
    : uniquePointCount > 2;
}

function getSelectedPointDeleteTarget() {
  const selectedPoint = getSelectedTopologyPoint();
  if (!selectedPoint) {
    return null;
  }
  if (canDeletePointFromShape(selectedPoint.shape, selectedPoint.index)) {
    return {
      shape: selectedPoint.shape,
      index: getEditablePointIndexForTopology(selectedPoint.shape, selectedPoint.index)
    };
  }
  const linkedEditableTarget = getLinkedTopologyVertices(
    selectedPoint.shape,
    selectedPoint.index,
    selectedPoint.point
  ).find((linked) => canDeletePointFromShape(linked.shape, linked.index));
  return linkedEditableTarget
    ? {
      shape: linkedEditableTarget.shape,
      index: getEditablePointIndexForTopology(
        linkedEditableTarget.shape,
        linkedEditableTarget.index
      )
    }
    : null;
}

function setTopologyPoint(shape, index, point) {
  if (!shape || !drawingLayer.contains(shape) || shape.dataset.kind === "pencil") {
    return;
  }
  const kind = shape.dataset.kind;
  if (kind === "rect") {
    const corners = getShapeVertices(shape);
    const opposite = corners[(index + 2) % corners.length];
    if (!opposite) {
      return;
    }
    const width = Math.abs(point.x - opposite.x);
    const height = Math.abs(point.y - opposite.y);
    if (width < MIN_SIZE || height < MIN_SIZE) {
      return;
    }
    shape.setAttribute("x", Math.min(point.x, opposite.x));
    shape.setAttribute("y", Math.min(point.y, opposite.y));
    shape.setAttribute("width", width);
    shape.setAttribute("height", height);
    return;
  }
  if (kind === "line") {
    const suffix = index === 0 ? "1" : "2";
    shape.setAttribute(`x${suffix}`, point.x);
    shape.setAttribute(`y${suffix}`, point.y);
    return;
  }
  if (kind === "arc") {
    const data = getArcData(shape);
    if (!data) {
      return;
    }
    const start = index === 0 ? point : data.start;
    const end = index === 1 ? point : data.end;
    if (distance(start, end) >= MIN_SIZE) {
      const through = getArcControlAfterEndpointMove(
        data.start,
        data.end,
        data.through,
        start,
        end
      );
      setArcData(shape, start, end, through);
    }
    return;
  }
  if (kind === "polygon" || kind === "pen") {
    const points = getElementPoints(shape);
    const isClosed = shape.dataset.closed === "true"
      || (points.length > 1 && distance(points[0], points[points.length - 1]) < 0.01);
    const logicalLength = isClosed ? points.length - 1 : points.length;
    if (index < 0 || index >= logicalLength) {
      return;
    }
    points[index] = { ...point };
    if (isClosed && index === 0) {
      points[points.length - 1] = { ...point };
    }
    shape.setAttribute("points", pointsToAttribute(points));
    shape.removeAttribute("data-selection-frame");
  }
}

function getDraggedTopologyPoint(shape, handleType, index) {
  if ([
    "line-end",
    "arc-point",
    "polygon-vertex",
    "pen-point",
    "rect-vertex"
  ].includes(handleType)) {
    return getTopologyPoints(shape)[index] || null;
  }
  return null;
}

function findLinkedTopologyVertices(shape, handleType, index) {
  const sourcePoint = getDraggedTopologyPoint(shape, handleType, index);
  if (!sourcePoint || isTopologyPointDetached(shape, index)) {
    return [];
  }
  const linked = [];
  [...drawingLayer.children].forEach((candidateShape) => {
    if (candidateShape.dataset.kind === "pencil") {
      return;
    }
    getTopologyPoints(candidateShape).forEach((candidatePoint, candidateIndex) => {
      if (candidateShape === shape && candidateIndex === index) {
        return;
      }
      if (topologyPointsAreConnected(
        shape,
        index,
        sourcePoint,
        candidateShape,
        candidateIndex,
        candidatePoint
      )) {
        linked.push({ shape: candidateShape, index: candidateIndex });
      }
    });
  });
  return linked;
}

function findShapeTopologyLinks(shape) {
  const links = [];
  getTopologyPoints(shape).forEach((sourcePoint, sourceIndex) => {
    if (isTopologyPointDetached(shape, sourceIndex)) {
      return;
    }
    const targets = [];
    [...drawingLayer.children].forEach((candidateShape) => {
      if (candidateShape === shape || candidateShape.dataset.kind === "pencil") {
        return;
      }
      getTopologyPoints(candidateShape).forEach((candidatePoint, candidateIndex) => {
        if (topologyPointsAreConnected(
          shape,
          sourceIndex,
          sourcePoint,
          candidateShape,
          candidateIndex,
          candidatePoint
        )) {
          targets.push({ shape: candidateShape, index: candidateIndex });
        }
      });
    });
    if (targets.length) {
      links.push({ sourceIndex, targets });
    }
  });
  return links;
}

function propagateDraggedTopologyPoint(point) {
  dragState?.linkedTopologyVertices?.forEach(({ shape, index }) => {
    setTopologyPoint(shape, index, point);
  });
}

function isDraggedLinkedSnap(snap) {
  if (!snap || snap.type !== "vertex" || !dragState?.linkedTopologyVertices) {
    return false;
  }

  return dragState.linkedTopologyVertices.some(({ shape, index }) =>
    snap.shape === shape && snap.vertexIndex === index
  );
}

function propagateShapeTopologyLinks(shape) {
  const sourcePoints = getTopologyPoints(shape);
  dragState?.shapeTopologyLinks?.forEach(({ sourceIndex, targets }) => {
    const point = sourcePoints[sourceIndex];
    if (!point) {
      return;
    }
    targets.forEach(({ shape: targetShape, index }) => {
      setTopologyPoint(targetShape, index, point);
    });
  });
}

function getSelectedShapeTopologyLinks() {
  const selectedSet = new Set(selectedShapes);
  return selectedShapes.map((shape) => {
    const links = findShapeTopologyLinks(shape)
      .map(({ sourceIndex, targets }) => ({
        sourceIndex,
        targets: targets.filter(({ shape: targetShape }) =>
          selectedSet.has(targetShape)
        )
      }))
      .filter(({ targets }) => targets.length);

    return { shape, links };
  }).filter(({ links }) => links.length);
}

function propagateTopologyLinkGroups(linkGroups) {
  linkGroups?.forEach(({ shape, links }) => {
    if (!shape || !drawingLayer.contains(shape)) {
      return;
    }

    const sourcePoints = getTopologyPoints(shape);
    links.forEach(({ sourceIndex, targets }) => {
      const point = sourcePoints[sourceIndex];
      if (!point) {
        return;
      }

      targets.forEach(({ shape: targetShape, index }) => {
        if (targetShape && drawingLayer.contains(targetShape)) {
          setTopologyPoint(targetShape, index, point);
        }
      });
    });
  });
}

function getSelectedShapeTopologyLinks() {
  const selectedSet = new Set(selectedShapes);
  return selectedShapes.map((shape) => {
    const links = findShapeTopologyLinks(shape)
      .map(({ sourceIndex, targets }) => ({
        sourceIndex,
        targets: targets.filter(({ shape: targetShape }) =>
          selectedSet.has(targetShape)
        )
      }))
      .filter(({ targets }) => targets.length);

    return { shape, links };
  }).filter(({ links }) => links.length);
}

function propagateTopologyLinkGroups(linkGroups) {
  linkGroups?.forEach(({ shape, links }) => {
    if (!shape || !drawingLayer.contains(shape)) {
      return;
    }

    const sourcePoints = getTopologyPoints(shape);
    links.forEach(({ sourceIndex, targets }) => {
      const point = sourcePoints[sourceIndex];
      if (!point) {
        return;
      }

      targets.forEach(({ shape: targetShape, index }) => {
        if (targetShape && drawingLayer.contains(targetShape)) {
          setTopologyPoint(targetShape, index, point);
        }
      });
    });
  });
}

function insertTopologyPointOnSegment(shape, segmentIndex, point) {
  if (!shape || shape.dataset.kind === "pencil") {
    return shape;
  }
  const data = getEditablePathData(shape);
  if (!data) {
    return shape;
  }
  const start = data.points[segmentIndex];
  const end = data.points[segmentIndex + 1];
  if (!start || !end
    || distance(start, point) < 0.01
    || distance(end, point) < 0.01) {
    return shape;
  }
  data.points.splice(segmentIndex + 1, 0, { ...point });
  const replacement = replaceWithPenPath(shape, data.points, data.closed);
  if (shape === selectedShape && replacement) {
    selectedShape = replacement;
    selectedShapes = [replacement];
  }
  return replacement || shape;
}

function materializeDraggedSegmentSnap() {
  const snap = dragState?.activeSnap;
  if (!snap || snap.type !== "segment" || snap.shape?.dataset.kind === "pencil") {
    return null;
  }
  const replacement = insertTopologyPointOnSegment(
    snap.shape,
    snap.segmentIndex,
    snap.point
  );
  return replacement
    ? {
      shape: replacement,
      vertexIndex: snap.segmentIndex + 1
    }
    : null;
}

function getEditablePathData(shape) {
  const kind = shape.dataset.kind;

  if (kind === "line") {
    return {
      points: [{
        x: Number(shape.getAttribute("x1")),
        y: Number(shape.getAttribute("y1"))
      }, {
        x: Number(shape.getAttribute("x2")),
        y: Number(shape.getAttribute("y2"))
      }],
      closed: false
    };
  }

  if (kind === "rect") {
    const x = Number(shape.getAttribute("x"));
    const y = Number(shape.getAttribute("y"));
    const width = Number(shape.getAttribute("width"));
    const height = Number(shape.getAttribute("height"));
    return {
      points: [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
        { x, y }
      ],
      closed: true
    };
  }

  if (kind === "polygon") {
    const points = getElementPoints(shape);
    return { points: [...points, { ...points[0] }], closed: true };
  }

  if (kind === "pen") {
    const points = getElementPoints(shape);
    if (shape.dataset.closed === "true") {
      const uniquePoints = removeDuplicateClosingPoint(points);
      return {
        points: [...uniquePoints, { ...uniquePoints[0] }],
        closed: true
      };
    }
    return {
      points,
      closed: false
    };
  }

  return null;
}

function replaceWithPenPath(shape, points, closed) {
  return replaceWithPenPathElement(shape, points, closed);
}

function mergeClosedShapeIntoPen(
  penShape,
  penVertexIndex,
  closedShape,
  closedVertexIndex
) {
  if (!penShape
    || !closedShape
    || !drawingLayer.contains(penShape)
    || !drawingLayer.contains(closedShape)
    || penShape.dataset.kind !== "pen") {
    return null;
  }
  const closedData = getEditablePathData(closedShape);
  if (!closedData?.closed) {
    return null;
  }

  const penPoints = getElementPoints(penShape);
  const closedPoints = closedData.points.slice(0, -1);
  if (!penPoints[penVertexIndex] || !closedPoints[closedVertexIndex]) {
    return null;
  }

  const cycle = [
    ...closedPoints.slice(closedVertexIndex),
    ...closedPoints.slice(0, closedVertexIndex),
    { ...closedPoints[closedVertexIndex] }
  ];
  cycle[0] = { ...penPoints[penVertexIndex] };
  cycle[cycle.length - 1] = { ...penPoints[penVertexIndex] };
  penPoints.splice(penVertexIndex + 1, 0, ...cycle.slice(1));
  penShape.setAttribute("points", pointsToAttribute(penPoints));
  penShape.removeAttribute("data-selection-frame");
  closedShape.remove();
  return penShape;
}

function mergeRectangleJoinedToPen(snap, handleType, draggedShape, draggedIndex) {
  if (!snap || snap.type !== "vertex") {
    return null;
  }
  if (handleType === "pen-point"
    && draggedShape?.dataset.kind === "pen"
    && snap.shape?.dataset.kind === "rect") {
    return mergeClosedShapeIntoPen(
      draggedShape,
      draggedIndex,
      snap.shape,
      snap.vertexIndex
    );
  }
  if (handleType === "rect-vertex"
    && draggedShape?.dataset.kind === "rect"
    && snap.shape?.dataset.kind === "pen") {
    return mergeClosedShapeIntoPen(
      snap.shape,
      snap.vertexIndex,
      draggedShape,
      draggedIndex
    );
  }
  return null;
}

function getMeasurementPathData(shape) {
  if (!shape || !drawingLayer.contains(shape)) {
    return null;
  }

  const kind = shape.dataset.kind;

  if (kind === "line") {
    return {
      kind,
      closed: false,
      points: [
        {
          x: Number(shape.getAttribute("x1")),
          y: Number(shape.getAttribute("y1"))
        },
        {
          x: Number(shape.getAttribute("x2")),
          y: Number(shape.getAttribute("y2"))
        }
      ]
    };
  }

  if (kind === "polygon") {
    return {
      kind,
      closed: true,
      points: removeDuplicateClosingPoint(getElementPoints(shape))
    };
  }

  if (kind === "pen") {
    const closed = shape.dataset.closed === "true";
    const points = getElementPoints(shape);
    return {
      kind,
      closed,
      points: closed ? removeDuplicateClosingPoint(points) : points
    };
  }

  return null;
}

function getMeasurementCenter(points) {
  if (!points.length) {
    return { x: WORKSPACE_SIZE / 2, y: WORKSPACE_SIZE / 2 };
  }

  return {
    x: points.reduce((total, point) => total + point.x, 0) / points.length,
    y: points.reduce((total, point) => total + point.y, 0) / points.length
  };
}

function getMeasurementSegments(data) {
  if (!data || data.points.length < 2) {
    return [];
  }

  const segmentCount = data.closed ? data.points.length : data.points.length - 1;
  return Array.from({ length: segmentCount }, (_, index) => ({
    index,
    start: data.points[index],
    end: data.points[(index + 1) % data.points.length]
  }));
}

function formatMeasurementNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return text.replace(".", ",");
}

function getAngleBetweenPoints(previous, vertex, next) {
  const firstAngle = Math.atan2(previous.y - vertex.y, previous.x - vertex.x);
  const secondAngle = Math.atan2(next.y - vertex.y, next.x - vertex.x);
  let difference = Math.abs(secondAngle - firstAngle);
  while (difference > Math.PI * 2) {
    difference -= Math.PI * 2;
  }
  if (difference > Math.PI) {
    difference = Math.PI * 2 - difference;
  }
  return difference * 180 / Math.PI;
}

function getMeasurementAngleItems(data) {
  if (!data || data.points.length < 3) {
    return [];
  }

  if (!data.closed) {
    return data.points.slice(1, -1).map((point, offset) => {
      const index = offset + 1;
      return {
        index,
        previous: data.points[index - 1],
        vertex: point,
        next: data.points[index + 1]
      };
    });
  }

  return data.points.map((point, index) => ({
    index,
    previous: data.points[(index - 1 + data.points.length) % data.points.length],
    vertex: point,
    next: data.points[(index + 1) % data.points.length]
  }));
}

function convertLengthFromPx(lengthPx) {
  return lengthPx * MEASURE_MM_PER_PX;
}

function convertLengthToPx(lengthMm) {
  return lengthMm / MEASURE_MM_PER_PX;
}

function getMeasurementUnitLabel(kind) {
  if (kind === "angle") {
    return "°";
  }
  return "mm";
}

function createMeasurementLengthTarget(segment, isActive) {
  return createSvgElement("line", {
    x1: segment.start.x,
    y1: segment.start.y,
    x2: segment.end.x,
    y2: segment.end.y,
    class: `measurement-hit measurement-hit-length${isActive ? " active" : ""}`,
    "data-measure-kind": "length",
    "data-measure-index": segment.index
  });
}

function getAngleOffsetPoint(item, center, offset) {
  const a1 = Math.atan2(item.previous.y - item.vertex.y, item.previous.x - item.vertex.x);
  const a2 = Math.atan2(item.next.y - item.vertex.y, item.next.x - item.vertex.x);
  let x = Math.cos(a1) + Math.cos(a2);
  let y = Math.sin(a1) + Math.sin(a2);

  if (Math.hypot(x, y) < 0.01) {
    x = item.vertex.x - center.x;
    y = item.vertex.y - center.y;
  }

  if ((item.vertex.x - center.x) * x + (item.vertex.y - center.y) * y < 0) {
    x = -x;
    y = -y;
  }

  const length = Math.hypot(x, y) || 1;
  return {
    x: clamp(item.vertex.x + x / length * offset, 18, WORKSPACE_SIZE - 18),
    y: clamp(item.vertex.y + y / length * offset, 18, WORKSPACE_SIZE - 18)
  };
}

function createMeasurementAngleTarget(item, center, isActive) {
  const point = getAngleOffsetPoint(item, center, 24 / canvasZoom);
  return createSvgElement("circle", {
    cx: point.x,
    cy: point.y,
    r: 6 / canvasZoom,
    class: `measurement-hit measurement-hit-angle${isActive ? " active" : ""}`,
    "data-measure-kind": "angle",
    "data-measure-index": item.index
  });
}

function getOffsetSideLabelPoint(segment, center) {
  const midpoint = {
    x: (segment.start.x + segment.end.x) / 2,
    y: (segment.start.y + segment.end.y) / 2
  };
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const length = Math.hypot(dx, dy) || 1;
  let normal = { x: -dy / length, y: dx / length };
  if ((midpoint.x - center.x) * normal.x + (midpoint.y - center.y) * normal.y < 0) {
    normal = { x: -normal.x, y: -normal.y };
  }
  const offset = 28 / canvasZoom;
  return {
    x: clamp(midpoint.x + normal.x * offset, 24, WORKSPACE_SIZE - 24),
    y: clamp(midpoint.y + normal.y * offset, 24, WORKSPACE_SIZE - 24)
  };
}

function getOffsetAngleLabelPoint(item, center) {
  return getAngleOffsetPoint(item, center, 46 / canvasZoom);
}

function closeMeasurementEditor() {
  if (!measurementEditor) {
    return;
  }
  measurementEditor.hidden = true;
  measurementEditor.classList.remove("has-error");
  if (measurementEditorError) {
    measurementEditorError.textContent = "";
  }
}

function showMeasurementError(message) {
  if (!measurementEditor || !measurementEditorError) {
    return;
  }
  measurementEditorError.textContent = message;
  measurementEditor.classList.add("has-error");
}

function clearMeasurementError() {
  if (!measurementEditor || !measurementEditorError) {
    return;
  }
  measurementEditorError.textContent = "";
  measurementEditor.classList.remove("has-error");
  measurementValueInput?.setCustomValidity("");
}

function positionMeasurementEditor(point) {
  if (!measurementEditor || !point) {
    return;
  }

  const frame = workspace.parentElement;
  const frameRect = frame.getBoundingClientRect();
  const svgRect = workspace.getBoundingClientRect();
  const editorWidth = measurementEditor.offsetWidth || 100;
  const editorHeight = measurementEditor.offsetHeight || 34;
  const x = svgRect.left - frameRect.left + point.x / WORKSPACE_SIZE * svgRect.width;
  const y = svgRect.top - frameRect.top + point.y / WORKSPACE_SIZE * svgRect.height;
  const left = clamp(x - editorWidth / 2, 6, Math.max(6, frameRect.width - editorWidth - 6));
  const top = clamp(y - editorHeight / 2, 6, Math.max(6, frameRect.height - editorHeight - 6));

  measurementEditor.style.left = `${left}px`;
  measurementEditor.style.top = `${top}px`;
}

function getActiveMeasurementData(data) {
  if (!activeMeasurement || !data) {
    return null;
  }

  if (activeMeasurement.kind === "length") {
    const segment = getMeasurementSegments(data).find((item) => item.index === activeMeasurement.index);
    if (!segment) {
      return null;
    }
    return {
      kind: "length",
      value: convertLengthFromPx(distance(segment.start, segment.end)),
      point: getOffsetSideLabelPoint(segment, getMeasurementCenter(data.points))
    };
  }

  if (activeMeasurement.kind === "angle") {
    const item = getMeasurementAngleItems(data).find((angleItem) => angleItem.index === activeMeasurement.index);
    if (!item) {
      return null;
    }
    return {
      kind: "angle",
      value: getAngleBetweenPoints(item.previous, item.vertex, item.next),
      point: getOffsetAngleLabelPoint(item, getMeasurementCenter(data.points))
    };
  }

  return null;
}

function updateMeasurementEditor(data, shouldFocus = false) {
  if (!measurementEditor || !measurementValueInput || !measurementUnitLabel) {
    return;
  }

  const editorData = getActiveMeasurementData(data);
  if (!editorData) {
    closeMeasurementEditor();
    return;
  }

  clearMeasurementError();
  measurementEditor.dataset.kind = editorData.kind;
  measurementUnitLabel.textContent = getMeasurementUnitLabel(editorData.kind);
  measurementValueInput.value = formatMeasurementNumber(editorData.value);
  measurementValueInput.min = editorData.kind === "angle" ? "1" : "0.3";
  measurementValueInput.max = editorData.kind === "angle" ? "179" : "";
  measurementEditor.hidden = false;
  positionMeasurementEditor(editorData.point);

  if (shouldFocus) {
    requestAnimationFrame(() => {
      measurementValueInput.focus();
      measurementValueInput.select();
    });
  }
}

function renderMeasurementControls() {
  renderSelectionInteractionLayer();
  handlesLayer.replaceChildren();
  pointActions.hidden = true;

  if (!selectedShape || !drawingLayer.contains(selectedShape)) {
    selectedShape = null;
    selectedShapes = [];
    activeMeasurement = null;
    closeMeasurementEditor();
    return;
  }

  const data = getMeasurementPathData(selectedShape);
  if (!data) {
    activeMeasurement = null;
    closeMeasurementEditor();
    return;
  }

  const center = getMeasurementCenter(data.points);

  getMeasurementSegments(data).forEach((segment) => {
    const isActive = activeMeasurement?.kind === "length" && activeMeasurement.index === segment.index;
    handlesLayer.append(createMeasurementLengthTarget(segment, isActive));
  });

  getMeasurementAngleItems(data).forEach((item) => {
    const isActive = activeMeasurement?.kind === "angle" && activeMeasurement.index === item.index;
    handlesLayer.append(createMeasurementAngleTarget(item, center, isActive));
  });

  updateMeasurementEditor(data);
}

function parseMeasurementInput(value) {
  return Number.parseFloat(String(value).trim().replace(",", "."));
}

function updateShapeFromMeasurement(shape, points, closed) {
  const kind = shape.dataset.kind;
  const cleanPoints = closed ? removeDuplicateClosingPoint(points) : points;

  if (kind === "line") {
    shape.setAttribute("x1", cleanPoints[0].x.toFixed(2));
    shape.setAttribute("y1", cleanPoints[0].y.toFixed(2));
    shape.setAttribute("x2", cleanPoints[1].x.toFixed(2));
    shape.setAttribute("y2", cleanPoints[1].y.toFixed(2));
  } else if (kind === "polygon" || kind === "pen") {
    shape.setAttribute("points", pointsToAttribute(cleanPoints));
    if (kind === "pen") {
      if (closed) {
        shape.dataset.closed = "true";
      } else {
        shape.removeAttribute("data-closed");
      }
    }
  }

  shape.removeAttribute("data-selection-frame");
}

function applyMeasurementLength(shape, edgeIndex, wantedLength) {
  const data = getMeasurementPathData(shape);
  const segment = getMeasurementSegments(data)[edgeIndex];
  if (!data || !segment) {
    return false;
  }

  if (!Number.isFinite(wantedLength) || wantedLength < 1) {
    showMeasurementError("Lunghezza non valida.");
    return false;
  }

  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const current = Math.hypot(dx, dy);
  if (current < 0.01) {
    showMeasurementError("Lato troppo corto.");
    return false;
  }

  const points = data.points.map((point) => ({ ...point }));
  const endIndex = data.closed ? (edgeIndex + 1) % points.length : edgeIndex + 1;
  points[endIndex] = {
    x: segment.start.x + dx / current * wantedLength,
    y: segment.start.y + dy / current * wantedLength
  };

  if (!pointsAreInsideWorkspace(points)) {
    showMeasurementError("Fuori dal foglio.");
    return false;
  }

  updateShapeFromMeasurement(shape, points, data.closed);
  recordHistory();
  selectShape(shape);
  return true;
}

function getMeasurementAngleRotationIndexes(points, vertexIndex, closed) {
  if (!closed) {
    return points
      .map((_, index) => index)
      .filter((index) => index > vertexIndex);
  }

  const indexes = [];
  const previousIndex = (vertexIndex - 1 + points.length) % points.length;
  let currentIndex = (vertexIndex + 1) % points.length;
  let guard = 0;

  while (currentIndex !== previousIndex && guard < points.length) {
    indexes.push(currentIndex);
    currentIndex = (currentIndex + 1) % points.length;
    guard += 1;
  }

  return indexes;
}

function normalizeRadians(angle) {
  let normalized = angle;
  while (normalized > Math.PI) {
    normalized -= Math.PI * 2;
  }
  while (normalized < -Math.PI) {
    normalized += Math.PI * 2;
  }
  return normalized;
}

function applyMeasurementAngle(shape, vertexIndex, wantedAngle) {
  const data = getMeasurementPathData(shape);
  const item = getMeasurementAngleItems(data).find((angleItem) => angleItem.index === vertexIndex);
  if (!data || !item) {
    return false;
  }

  if (!Number.isFinite(wantedAngle) || wantedAngle <= 0 || wantedAngle >= 180) {
    showMeasurementError("Angolo tra 1° e 179°.");
    return false;
  }

  const points = data.points.map((point) => ({ ...point }));
  const nextIndex = data.closed ? (vertexIndex + 1) % points.length : vertexIndex + 1;
  const nextPoint = points[nextIndex];
  const vertex = points[vertexIndex];
  const previous = data.closed
    ? points[(vertexIndex - 1 + points.length) % points.length]
    : points[vertexIndex - 1];

  if (!previous || !nextPoint || distance(vertex, nextPoint) < 0.01) {
    showMeasurementError("Angolo non modificabile.");
    return false;
  }

  const baseAngle = Math.atan2(previous.y - vertex.y, previous.x - vertex.x);
  const currentNextAngle = Math.atan2(nextPoint.y - vertex.y, nextPoint.x - vertex.x);
  const direction = normalizeRadians(currentNextAngle - baseAngle);
  const sign = direction < 0 ? -1 : 1;
  const targetNextAngle = baseAngle + sign * wantedAngle * Math.PI / 180;
  const rotationDelta = normalizeRadians(targetNextAngle - currentNextAngle) * 180 / Math.PI;
  const indexesToRotate = getMeasurementAngleRotationIndexes(points, vertexIndex, data.closed);

  if (!indexesToRotate.length) {
    showMeasurementError("Angolo non modificabile.");
    return false;
  }

  indexesToRotate.forEach((index) => {
    points[index] = rotatePoint(points[index], vertex, rotationDelta);
  });

  if (!pointsAreInsideWorkspace(points)) {
    showMeasurementError("Fuori dal foglio.");
    return false;
  }

  updateShapeFromMeasurement(shape, points, data.closed);
  recordHistory();
  selectShape(shape);
  return true;
}

function applyMeasurementEditorValue() {
  if (!selectedShape || !activeMeasurement || !measurementValueInput) {
    return;
  }

  clearMeasurementError();
  const rawValue = parseMeasurementInput(measurementValueInput.value);
  const ok = activeMeasurement.kind === "length"
    ? applyMeasurementLength(selectedShape, activeMeasurement.index, convertLengthToPx(rawValue))
    : applyMeasurementAngle(selectedShape, activeMeasurement.index, rawValue);

  if (ok) {
    const data = getMeasurementPathData(selectedShape);
    updateMeasurementEditor(data);
  }
}

function handleMeasurementControl(target) {
  if (!selectedShape || !drawingLayer.contains(selectedShape)) {
    return;
  }

  const kind = target.dataset.measureKind;
  const index = Number(target.dataset.measureIndex);
  if (!Number.isFinite(index) || !["length", "angle"].includes(kind)) {
    return;
  }

  activeMeasurement = { kind, index };
  renderMeasurementControls();
  updateMeasurementEditor(getMeasurementPathData(selectedShape), true);
}

function addPointToShape(shape, edgeIndex, clickPoint) {
  const data = getEditablePathData(shape);
  if (!data) {
    return;
  }
  const start = data.points[edgeIndex];
  const end = data.points[edgeIndex + 1];
  const newPoint = projectPointOnSegment(clickPoint, start, end);

  if (distance(start, newPoint) < 4 || distance(newPoint, end) < 4) {
    return;
  }

  data.points.splice(edgeIndex + 1, 0, newPoint);
  const newShape = replaceWithPenPath(shape, data.points, data.closed);
  recordHistory();
  selectShape(newShape);
  setActiveTool("select");
}

function remapDetachedTopologyAfterDelete(shape, deletedIndex) {
  const indexes = getDetachedTopologyIndexes(shape);

  if (!indexes.size) {
    return;
  }

  const remapped = [...indexes]
    .filter((index) => index !== deletedIndex)
    .map((index) => index > deletedIndex ? index - 1 : index);

  if (remapped.length) {
    shape.dataset.detachedTopology = JSON.stringify([...new Set(remapped)]);
  } else {
    shape.removeAttribute("data-detached-topology");
  }
}

function deletePointFromShape(shape, pointIndex) {
  const data = getEditablePathData(shape);
  if (!data) {
    return;
  }

  const isPen = shape.dataset.kind === "pen";
  const normalizedIndex = data.closed && pointIndex === data.points.length - 1
    ? 0
    : pointIndex;
  const deletedPoint = data.points[normalizedIndex];
  const linkedToDeletedPoint = isPen && deletedPoint
    ? getLinkedTopologyVertices(shape, normalizedIndex, deletedPoint)
    : [];

  if (data.closed) {
    const uniquePoints = data.points.slice(0, -1);
    if (uniquePoints.length <= 3) {
      return;
    }
    uniquePoints.splice(normalizedIndex, 1);
    data.points = [...uniquePoints, { ...uniquePoints[0] }];
  } else {
    if (data.points.length <= 2) {
      return;
    }
    data.points.splice(pointIndex, 1);
  }

  let newShape = shape;

  if (isPen) {
    if (data.closed) {
      newShape = replaceWithPenPath(shape, data.points, true);
    } else {
      shape.setAttribute("points", pointsToAttribute(data.points));
      shape.removeAttribute("data-closed");
      shape.removeAttribute("data-selection-frame");
    }
    remapDetachedTopologyAfterDelete(newShape, normalizedIndex);
  } else {
    newShape = replaceWithPenPath(shape, data.points, data.closed);
  }

  if (!newShape) {
    return;
  }

  if (linkedToDeletedPoint.length) {
    const topologyPoints = getTopologyPoints(newShape);
    const replacementIndex = Math.min(normalizedIndex, topologyPoints.length - 1);
    const replacementPoint = topologyPoints[replacementIndex];

    if (replacementPoint) {
      linkedToDeletedPoint.forEach((linked) => {
        setTopologyPoint(linked.shape, linked.index, replacementPoint);
        attachTopologyPoint(linked.shape, linked.index);
      });
      attachTopologyPoint(newShape, replacementIndex);
    }
  }

  recordHistory();
  selectShape(newShape);
  setActiveTool("select");
}

function deleteSelectedPoint() {
  const deleteTarget = getSelectedPointDeleteTarget();
  if (!deleteTarget) {
    return;
  }
  deletePointFromShape(deleteTarget.shape, deleteTarget.index);
}

function updateSelectedText() {
  if (!selectedShape || selectedShape.dataset.kind !== "text") {
    return;
  }

  const previous = {
    text: selectedShape.textContent,
    size: selectedShape.getAttribute("font-size"),
    font: selectedShape.getAttribute("font-family"),
    x: selectedShape.getAttribute("x"),
    y: selectedShape.getAttribute("y")
  };
  const value = textValueInput.value.trim();
  const size = clamp(Number.parseInt(textSizeInput.value, 10) || 32, 8, 120);
  const font = textFontInput.value;

  if (!value) {
    textValueInput.value = previous.text;
    return;
  }

  textSizeInput.value = size;
  selectedShape.textContent = value;
  selectedShape.setAttribute("font-size", size);
  selectedShape.setAttribute("font-family", font);
  applyTextRotation(selectedShape);

  if (!keepTextInsideWorkspace(selectedShape)) {
    selectedShape.textContent = previous.text;
    selectedShape.setAttribute("font-size", previous.size);
    selectedShape.setAttribute("font-family", previous.font);
    selectedShape.setAttribute("x", previous.x);
    selectedShape.setAttribute("y", previous.y);
    textValueInput.value = previous.text;
    textSizeInput.value = previous.size;
    textFontInput.value = previous.font;
    renderHandles();
    return;
  }

  renderHandles();
  recordHistory();
}

function updateFontOptionPreviews() {
  const previewText = textValueInput.value.trim() || "Testo";
  [...textFontInput.options].forEach((option) => {
    option.textContent = previewText;
  });
}

function createOpenPath(points) {
  return createPenPath(points, false);
}

function deleteEdge(shape, edgeIndex) {
  const kind = shape.dataset.kind;
  let resultingParts = [];

  if (kind === "rect") {
    const x = Number(shape.getAttribute("x"));
    const y = Number(shape.getAttribute("y"));
    const width = Number(shape.getAttribute("width"));
    const height = Number(shape.getAttribute("height"));
    const points = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ];
    resultingParts = [[
      ...points.slice(edgeIndex + 1),
      ...points.slice(0, edgeIndex + 1)
    ]];
  } else if (kind === "polygon") {
    const points = getElementPoints(shape);
    resultingParts = [[
      ...points.slice(edgeIndex + 1),
      ...points.slice(0, edgeIndex + 1)
    ]];
  } else if (kind === "line") {
    resultingParts = [];
  } else if (kind === "pen" && shape.dataset.closed === "true") {
    const data = getEditablePathData(shape);
    const points = data.points.slice(0, -1);
    resultingParts = [[
      ...points.slice(edgeIndex + 1),
      ...points.slice(0, edgeIndex + 1)
    ]];
  } else if (kind === "pen") {
    const points = getElementPoints(shape);
    resultingParts = [
      points.slice(0, edgeIndex + 1),
      points.slice(edgeIndex + 1)
    ];
  } else {
    return;
  }

  const insertionPoint = shape.nextSibling;
  shape.remove();
  resultingParts.forEach((points) => {
    const newPath = createOpenPath(points);
    if (newPath) {
      drawingLayer.insertBefore(newPath, insertionPoint);
    }
  });

  selectShape(null);
  renderEdgeDeleteTargets();
  recordHistory();
}

function startHandleDrag(handle, event) {
  const point = getSvgPoint(event);
  const startBox = selectedShape.getBBox();
  const startSelectionFrame = selectedShape.dataset.kind === "arc"
    ? getArcFrame(selectedShape)
    : selectedShape.dataset.kind === "rect"
      || ["polygon", "pen", "pencil"].includes(selectedShape.dataset.kind)
      ? getSelectionFrame(selectedShape)
      : null;
  const rotationCenter = getShapeRotationCenter(selectedShape);
  dragState = {
    type: handle.dataset.handle,
    index: Number(handle.dataset.index),
    startPoint: point,
    startBox,
    startAttributes: getShapeSnapshot(selectedShape),
    startSelectionFrame,
    rotationCenter,
    previousAngle: Math.atan2(
      point.y - rotationCenter.y,
      point.x - rotationCenter.x
    ),
    linkedTopologyVertices: findLinkedTopologyVertices(
      selectedShape,
      handle.dataset.handle,
      Number(handle.dataset.index)
    ),
    shapeTopologyLinks: ["move", "rotate"].includes(handle.dataset.handle)
      ? findShapeTopologyLinks(selectedShape)
      : [],
    linkedShapeSnapshots: []
  };
  if (["move", "rotate"].includes(handle.dataset.handle)) {
    const seen = new Set();
    seen.add(selectedShape);
    dragState.shapeTopologyLinks.forEach(({ targets }) => {
      targets.forEach(({ shape: targetShape }) => {
        if (!seen.has(targetShape)) {
          seen.add(targetShape);
          dragState.linkedShapeSnapshots.push({
            shape: targetShape,
            snapshot: getShapeSnapshot(targetShape)
          });
        }
      });
    });
  }
  if (handle.dataset.handle === "pencil-end") {
    const points = getElementPoints(selectedShape);
    const endpointIndex = Number(handle.dataset.index);
    dragState.pencilExtensionPoints = endpointIndex === 0
      ? [...points].reverse()
      : points;
    dragState.pencilExtensionStartIndex =
      dragState.pencilExtensionPoints.length - 1;
  }
  workspace.setPointerCapture(event.pointerId);
}

function startGroupMove(event) {
  const point = getSvgPoint(event);
  dragState = {
    type: "group-move",
    startPoint: point,
    startBox: getShapesBounds(selectedShapes),
    startSelectionFrame: groupSelectionFrame.map((item) => ({ ...item })),
    shapes: selectedShapes.map((shape) => ({
      shape,
      snapshot: getShapeSnapshot(shape),
      selectionFrame: ["polygon", "pen", "pencil"].includes(shape.dataset.kind)
        ? getSelectionFrame(shape)
        : null
    }))
  };
  workspace.setPointerCapture(event.pointerId);
}

function startGroupScale(event, handle) {
  const point = getSvgPoint(event);
  dragState = {
    type: "group-scale",
    index: Number(handle.dataset.index),
    startPoint: point,
    startSelectionFrame: groupSelectionFrame.map((item) => ({ ...item })),
    shapes: selectedShapes.map((shape) => ({
      shape,
      snapshot: getShapeSnapshot(shape),
      selectionFrame: ["polygon", "pen", "pencil"].includes(shape.dataset.kind)
        ? getSelectionFrame(shape)
        : null
    }))
  };
  workspace.setPointerCapture(event.pointerId);
}

function scalePointFromOrigin(point, origin, scale) {
  return {
    x: origin.x + (point.x - origin.x) * scale,
    y: origin.y + (point.y - origin.y) * scale
  };
}

function scaleShapeFromSnapshot(shape, snapshot, selectionFrame, origin, scale) {
  if (shape.dataset.kind === "rect") {
    const first = scalePointFromOrigin(
      { x: snapshot.x, y: snapshot.y },
      origin,
      scale
    );
    shape.setAttribute("x", first.x);
    shape.setAttribute("y", first.y);
    shape.setAttribute("width", snapshot.width * scale);
    shape.setAttribute("height", snapshot.height * scale);
  } else if (shape.dataset.kind === "circle") {
    const center = scalePointFromOrigin(
      { x: snapshot.cx, y: snapshot.cy },
      origin,
      scale
    );
    shape.setAttribute("cx", center.x);
    shape.setAttribute("cy", center.y);
    shape.setAttribute("r", snapshot.r * scale);
  } else if (shape.dataset.kind === "ellipse") {
    const center = scalePointFromOrigin(
      { x: snapshot.cx, y: snapshot.cy },
      origin,
      scale
    );
    shape.setAttribute("cx", center.x);
    shape.setAttribute("cy", center.y);
    shape.setAttribute("rx", snapshot.rx * scale);
    shape.setAttribute("ry", snapshot.ry * scale);
    applyEllipseRotation(shape);
  } else if (shape.dataset.kind === "line") {
    const first = scalePointFromOrigin(
      { x: snapshot.x1, y: snapshot.y1 },
      origin,
      scale
    );
    const second = scalePointFromOrigin(
      { x: snapshot.x2, y: snapshot.y2 },
      origin,
      scale
    );
    shape.setAttribute("x1", first.x);
    shape.setAttribute("y1", first.y);
    shape.setAttribute("x2", second.x);
    shape.setAttribute("y2", second.y);
  } else if (shape.dataset.kind === "arc") {
    shape.dataset.arcStretch = snapshot.stretch;
    shape.dataset.arcWidth = snapshot.width;
    setArcData(
      shape,
      scalePointFromOrigin(snapshot.start, origin, scale),
      scalePointFromOrigin(snapshot.end, origin, scale),
      scalePointFromOrigin(snapshot.through, origin, scale)
    );
  } else if (shape.dataset.kind === "text") {
    const point = scalePointFromOrigin(
      { x: snapshot.x, y: snapshot.y },
      origin,
      scale
    );
    shape.setAttribute("x", point.x);
    shape.setAttribute("y", point.y);
    shape.setAttribute("font-size", Math.max(8, snapshot.fontSize * scale));
    applyTextRotation(shape);
  } else {
    const points = snapshot.points.map((item) =>
      scalePointFromOrigin(item, origin, scale)
    );
    shape.setAttribute("points", pointsToAttribute(points));
    if (selectionFrame) {
      setSelectionFrame(
        shape,
        selectionFrame.map((item) => scalePointFromOrigin(item, origin, scale))
      );
    }
  }
}

function scaleSelectedGroup(point) {
  const frame = dragState.startSelectionFrame;
  const cornerIndex = dragState.index;
  const opposite = frame[(cornerIndex + 2) % 4];
  const corner = frame[cornerIndex];
  const diagonal = {
    x: corner.x - opposite.x,
    y: corner.y - opposite.y
  };
  const diagonalLengthSquared = diagonal.x ** 2 + diagonal.y ** 2;

  if (diagonalLengthSquared < 0.01) {
    return;
  }

  const pointerVector = {
    x: point.x - opposite.x,
    y: point.y - opposite.y
  };
  const wantedScale = (
    pointerVector.x * diagonal.x
    + pointerVector.y * diagonal.y
  ) / diagonalLengthSquared;
  const minimumDimension = Math.min(
    distance(frame[0], frame[1]),
    distance(frame[1], frame[2])
  );
  const minimumScale = MIN_SIZE / Math.max(minimumDimension, 0.01);
  const scale = Math.max(wantedScale, minimumScale);
  const nextFrame = frame.map((item) => scalePointFromOrigin(item, opposite, scale));

  if (!pointsAreInsideWorkspace(nextFrame)) {
    return;
  }

  dragState.shapes.forEach(({ shape, snapshot, selectionFrame }) => {
    if (drawingLayer.contains(shape)) {
      scaleShapeFromSnapshot(shape, snapshot, selectionFrame, opposite, scale);
    }
  });

  groupSelectionFrame = nextFrame.map((item) => ({ ...item }));
  dragState.preservedGroupFrame = groupSelectionFrame.map((item) => ({ ...item }));
  selectedShapes.forEach((shape) => propagateShapeTopologyLinks(shape));
  storeGroupSelectionFrame(selectedShapes, groupSelectionFrame);
}

function convertRectangleForGroupRotation(shape) {
  if (shape.dataset.kind !== "rect") {
    return shape;
  }

  const x = Number(shape.getAttribute("x"));
  const y = Number(shape.getAttribute("y"));
  const width = Number(shape.getAttribute("width"));
  const height = Number(shape.getAttribute("height"));
  const corners = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height }
  ];
  const path = replaceWithPenPath(
    shape,
    [...corners, { ...corners[0] }],
    true
  );
  path.dataset.rectangle = "true";
  setSelectionFrame(path, corners);
  return path;
}

function startGroupRotate(event) {
  selectedShapes = selectedShapes.map(convertRectangleForGroupRotation);
  selectedShape = null;
  const topologyLinks = getSelectedShapeTopologyLinks();
  const center = getFrameCenter(groupSelectionFrame);
  const point = getSvgPoint(event);
  dragState = {
    type: "group-rotate",
    rotationCenter: center,
    previousAngle: Math.atan2(point.y - center.y, point.x - center.x),
    groupTopologyLinks: topologyLinks
  };
  workspace.setPointerCapture(event.pointerId);
}

function getRotatedShapeBoundary(shape, center, angle) {
  if (shape.dataset.kind === "circle") {
    const rotatedCenter = rotatePoint({
      x: Number(shape.getAttribute("cx")),
      y: Number(shape.getAttribute("cy"))
    }, center, angle);
    const radius = Number(shape.getAttribute("r"));
    return [
      { x: rotatedCenter.x - radius, y: rotatedCenter.y - radius },
      { x: rotatedCenter.x + radius, y: rotatedCenter.y + radius }
    ];
  }
  if (shape.dataset.kind === "ellipse") {
    const currentCenter = {
      x: Number(shape.getAttribute("cx")),
      y: Number(shape.getAttribute("cy"))
    };
    const rotatedCenter = rotatePoint(currentCenter, center, angle);
    const nextAngle = getEllipseRotation(shape) + angle;
    const radiusX = Number(shape.getAttribute("rx"));
    const radiusY = Number(shape.getAttribute("ry"));
    const radians = nextAngle * Math.PI / 180;
    const extentX = Math.hypot(
      radiusX * Math.cos(radians),
      radiusY * Math.sin(radians)
    );
    const extentY = Math.hypot(
      radiusX * Math.sin(radians),
      radiusY * Math.cos(radians)
    );
    return [
      { x: rotatedCenter.x - extentX, y: rotatedCenter.y - extentY },
      { x: rotatedCenter.x + extentX, y: rotatedCenter.y + extentY }
    ];
  }
  if (shape.dataset.kind === "text") {
    return getTextRotatedCorners(shape)
      .map((point) => rotatePoint(point, center, angle));
  }
  if (shape.dataset.kind === "line") {
    return getShapeVertices(shape)
      .map((point) => rotatePoint(point, center, angle));
  }
  if (shape.dataset.kind === "arc") {
    const data = getArcData(shape);
    return getDisplayedArcPoints(
      data.start,
      data.end,
      data.through,
      getArcStretch(shape),
      getArcWidth(shape)
    )
      .map((point) => rotatePoint(point, center, angle));
  }
  return getElementPoints(shape)
    .map((point) => rotatePoint(point, center, angle));
}

function rotateShapeAroundPoint(shape, center, angle) {
  const kind = shape.dataset.kind;
  if (kind === "circle") {
    const rotatedCenter = rotatePoint({
      x: Number(shape.getAttribute("cx")),
      y: Number(shape.getAttribute("cy"))
    }, center, angle);
    shape.setAttribute("cx", rotatedCenter.x);
    shape.setAttribute("cy", rotatedCenter.y);
  } else if (kind === "ellipse") {
    const rotatedCenter = rotatePoint({
      x: Number(shape.getAttribute("cx")),
      y: Number(shape.getAttribute("cy"))
    }, center, angle);
    shape.setAttribute("cx", rotatedCenter.x);
    shape.setAttribute("cy", rotatedCenter.y);
    shape.dataset.rotation = (getEllipseRotation(shape) + angle + 360) % 360;
    applyEllipseRotation(shape);
  } else if (kind === "text") {
    const box = shape.getBBox();
    const textCenter = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2
    };
    const rotatedCenter = rotatePoint(textCenter, center, angle);
    shape.setAttribute(
      "x",
      Number(shape.getAttribute("x")) + rotatedCenter.x - textCenter.x
    );
    shape.setAttribute(
      "y",
      Number(shape.getAttribute("y")) + rotatedCenter.y - textCenter.y
    );
    shape.dataset.rotation = (getTextRotation(shape) + angle + 360) % 360;
    applyTextRotation(shape);
  } else if (kind === "line") {
    const points = getShapeVertices(shape)
      .map((point) => rotatePoint(point, center, angle));
    shape.setAttribute("x1", points[0].x);
    shape.setAttribute("y1", points[0].y);
    shape.setAttribute("x2", points[1].x);
    shape.setAttribute("y2", points[1].y);
  } else if (kind === "arc") {
    const data = getArcData(shape);
    const points = [data.start, data.end, data.through]
      .map((point) => rotatePoint(point, center, angle));
    setArcData(shape, points[0], points[1], points[2]);
  } else {
    const points = getElementPoints(shape)
      .map((point) => rotatePoint(point, center, angle));
    shape.setAttribute("points", pointsToAttribute(points));
    const frame = getSelectionFrame(shape)
      .map((point) => rotatePoint(point, center, angle));
    setSelectionFrame(shape, frame);
  }
}

function rotateSelectedGroup(angle) {
  const center = dragState.rotationCenter;
  const canRotate = selectedShapes.every((shape) =>
    pointsAreInsideWorkspace(getRotatedShapeBoundary(shape, center, angle))
  );
  if (!canRotate) {
    return false;
  }

  selectedShapes.forEach((shape) => rotateShapeAroundPoint(shape, center, angle));
  propagateTopologyLinkGroups(dragState.groupTopologyLinks);

  groupSelectionFrame = groupSelectionFrame
    .map((point) => rotatePoint(point, center, angle));
  dragState.preservedGroupFrame = cloneFrame(groupSelectionFrame);
  storeGroupSelectionFrame(selectedShapes, groupSelectionFrame);
  return true;
}

function startMarqueeSelection(point, pointerId) {
  selectShapes([]);
  hoveredShape = null;
  dragState = {
    type: "marquee",
    startPoint: point,
    currentPoint: point
  };
  workspace.setPointerCapture(pointerId);
  renderMarqueeSelection();
}

function getMarqueeBox() {
  const start = dragState.startPoint;
  const end = dragState.currentPoint;
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function renderMarqueeSelection() {
  handlesLayer.replaceChildren();
  const box = getMarqueeBox();
  handlesLayer.append(createSvgElement("rect", {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    class: "marquee-selection"
  }));
}

function finishMarqueeSelection() {
  const box = getMarqueeBox();
  if (box.width < 3 && box.height < 3) {
    selectShapes([]);
    return;
  }
  const shapes = [...drawingLayer.children]
    .filter((shape) => boxesIntersect(box, getShapeBounds(shape)));
  selectShapes(shapes);
}

function getShapeSnapshot(shape) {
  if (shape.dataset.kind === "rect") {
    return {
      x: Number(shape.getAttribute("x")),
      y: Number(shape.getAttribute("y")),
      width: Number(shape.getAttribute("width")),
      height: Number(shape.getAttribute("height"))
    };
  }
  if (shape.dataset.kind === "circle") {
    return {
      cx: Number(shape.getAttribute("cx")),
      cy: Number(shape.getAttribute("cy")),
      r: Number(shape.getAttribute("r"))
    };
  }
  if (shape.dataset.kind === "ellipse") {
    const bounds = getEllipseBounds(shape);
    return {
      cx: Number(shape.getAttribute("cx")),
      cy: Number(shape.getAttribute("cy")),
      rx: Number(shape.getAttribute("rx")),
      ry: Number(shape.getAttribute("ry")),
      rotation: getEllipseRotation(shape),
      bounds
    };
  }
  if (shape.dataset.kind === "line") {
    return {
      x1: Number(shape.getAttribute("x1")),
      y1: Number(shape.getAttribute("y1")),
      x2: Number(shape.getAttribute("x2")),
      y2: Number(shape.getAttribute("y2"))
    };
  }
  if (shape.dataset.kind === "arc") {
    const data = getArcData(shape);
    return {
      start: { ...data.start },
      end: { ...data.end },
      through: { ...data.through },
      stretch: getArcStretch(shape),
      width: getArcWidth(shape)
    };
  }
  if (shape.dataset.kind === "text") {
    const corners = getTextRotatedCorners(shape);
    return {
      x: Number(shape.getAttribute("x")),
      y: Number(shape.getAttribute("y")),
      fontSize: Number(shape.getAttribute("font-size")),
      corners,
      bounds: {
        x: Math.min(...corners.map((point) => point.x)),
        y: Math.min(...corners.map((point) => point.y)),
        width: Math.max(...corners.map((point) => point.x))
          - Math.min(...corners.map((point) => point.x)),
        height: Math.max(...corners.map((point) => point.y))
          - Math.min(...corners.map((point) => point.y))
      }
    };
  }
  return { points: getElementPoints(shape) };
}

function moveShapeFromSnapshot(shape, snapshot, selectionFrame, dx, dy) {
  if (shape.dataset.kind === "rect") {
    shape.setAttribute("x", snapshot.x + dx);
    shape.setAttribute("y", snapshot.y + dy);
  } else if (shape.dataset.kind === "circle") {
    shape.setAttribute("cx", snapshot.cx + dx);
    shape.setAttribute("cy", snapshot.cy + dy);
  } else if (shape.dataset.kind === "ellipse") {
    shape.setAttribute("cx", snapshot.cx + dx);
    shape.setAttribute("cy", snapshot.cy + dy);
    applyEllipseRotation(shape);
  } else if (shape.dataset.kind === "line") {
    shape.setAttribute("x1", snapshot.x1 + dx);
    shape.setAttribute("y1", snapshot.y1 + dy);
    shape.setAttribute("x2", snapshot.x2 + dx);
    shape.setAttribute("y2", snapshot.y2 + dy);
  } else if (shape.dataset.kind === "arc") {
    shape.dataset.arcStretch = snapshot.stretch;
    shape.dataset.arcWidth = snapshot.width;
    setArcData(
      shape,
      { x: snapshot.start.x + dx, y: snapshot.start.y + dy },
      { x: snapshot.end.x + dx, y: snapshot.end.y + dy },
      { x: snapshot.through.x + dx, y: snapshot.through.y + dy }
    );
  } else if (shape.dataset.kind === "text") {
    shape.setAttribute("x", snapshot.x + dx);
    shape.setAttribute("y", snapshot.y + dy);
    applyTextRotation(shape);
  } else {
    shape.setAttribute("points", pointsToAttribute(snapshot.points.map((item) => ({
      x: item.x + dx,
      y: item.y + dy
    }))));
    if (selectionFrame) {
      setSelectionFrame(shape, selectionFrame.map((item) => ({
        x: item.x + dx,
        y: item.y + dy
      })));
    }
  }
}

function moveSelectedGroup(point) {
  const wantedDx = point.x - dragState.startPoint.x;
  const wantedDy = point.y - dragState.startPoint.y;
  const box = dragState.startBox;
  const dx = clamp(
    wantedDx,
    EDGE_MARGIN - box.x,
    WORKSPACE_SIZE - EDGE_MARGIN - (box.x + box.width)
  );
  const dy = clamp(
    wantedDy,
    EDGE_MARGIN - box.y,
    WORKSPACE_SIZE - EDGE_MARGIN - (box.y + box.height)
  );
  dragState.shapes.forEach(({ shape, snapshot, selectionFrame }) => {
    moveShapeFromSnapshot(shape, snapshot, selectionFrame, dx, dy);
  });
  groupSelectionFrame = dragState.startSelectionFrame.map((item) => ({
    x: item.x + dx,
    y: item.y + dy
  }));
  storeGroupSelectionFrame(selectedShapes, groupSelectionFrame);
}

function rotateShapeFromSnapshot(shape, snapshot, angleDeg, center) {
  const angleRad = angleDeg * Math.PI / 180;
  if (shape.dataset.kind === "line") {
    const p1 = rotatePoint({ x: snapshot.x1, y: snapshot.y1 }, center, angleRad);
    const p2 = rotatePoint({ x: snapshot.x2, y: snapshot.y2 }, center, angleRad);
    shape.setAttribute("x1", p1.x);
    shape.setAttribute("y1", p1.y);
    shape.setAttribute("x2", p2.x);
    shape.setAttribute("y2", p2.y);
  } else if (shape.dataset.kind === "rect") {
    const corners = [
      { x: snapshot.x, y: snapshot.y },
      { x: snapshot.x + snapshot.width, y: snapshot.y },
      { x: snapshot.x + snapshot.width, y: snapshot.y + snapshot.height },
      { x: snapshot.x, y: snapshot.y + snapshot.height }
    ].map((p) => rotatePoint(p, center, angleRad));
    const closedPoints = [...corners, { ...corners[0] }];
    const oldId = shape.id;
    const newId = currentId++;
    shape.id = "shape-" + newId;
    shapeMap[oldId] = undefined;
    shapeMap[shape.id] = shape;
    shape.setAttribute("points", pointsToAttribute(closedPoints));
    shape.dataset.kind = "pen";
    shape.dataset.rectangle = "true";
  } else if (shape.dataset.kind === "polygon" || shape.dataset.kind === "pen") {
    const rotated = snapshot.points.map((p) => rotatePoint(p, center, angleRad));
    shape.setAttribute("points", pointsToAttribute(rotated));
  }
}

function moveSelectedShape(point) {
  const { startPoint, startBox, startAttributes } = dragState;
  const wantedDx = point.x - startPoint.x;
  const wantedDy = point.y - startPoint.y;
  const movementBox = selectedShape.dataset.kind === "text"
    || selectedShape.dataset.kind === "ellipse"
    ? startAttributes.bounds
    : startBox;
  const dx = clamp(
    wantedDx,
    EDGE_MARGIN - movementBox.x,
    WORKSPACE_SIZE - EDGE_MARGIN - (movementBox.x + movementBox.width)
  );
  const dy = clamp(
    wantedDy,
    EDGE_MARGIN - movementBox.y,
    WORKSPACE_SIZE - EDGE_MARGIN - (movementBox.y + movementBox.height)
  );

  if (selectedShape.dataset.kind === "rect") {
    selectedShape.setAttribute("x", startAttributes.x + dx);
    selectedShape.setAttribute("y", startAttributes.y + dy);
  } else if (selectedShape.dataset.kind === "circle") {
    selectedShape.setAttribute("cx", startAttributes.cx + dx);
    selectedShape.setAttribute("cy", startAttributes.cy + dy);
  } else if (selectedShape.dataset.kind === "ellipse") {
    selectedShape.setAttribute("cx", startAttributes.cx + dx);
    selectedShape.setAttribute("cy", startAttributes.cy + dy);
    applyEllipseRotation(selectedShape);
  } else if (selectedShape.dataset.kind === "line") {
    selectedShape.setAttribute("x1", startAttributes.x1 + dx);
    selectedShape.setAttribute("y1", startAttributes.y1 + dy);
    selectedShape.setAttribute("x2", startAttributes.x2 + dx);
    selectedShape.setAttribute("y2", startAttributes.y2 + dy);
  } else if (selectedShape.dataset.kind === "arc") {
    selectedShape.dataset.arcStretch = startAttributes.stretch;
    selectedShape.dataset.arcWidth = startAttributes.width;
    setArcData(
      selectedShape,
      { x: startAttributes.start.x + dx, y: startAttributes.start.y + dy },
      { x: startAttributes.end.x + dx, y: startAttributes.end.y + dy },
      { x: startAttributes.through.x + dx, y: startAttributes.through.y + dy }
    );
  } else if (selectedShape.dataset.kind === "text") {
    selectedShape.setAttribute("x", startAttributes.x + dx);
    selectedShape.setAttribute("y", startAttributes.y + dy);
    applyTextRotation(selectedShape);
  } else {
    const movedPoints = startAttributes.points.map((item) => ({
      x: item.x + dx,
      y: item.y + dy
    }));
    selectedShape.setAttribute("points", pointsToAttribute(movedPoints));
    if (dragState.startSelectionFrame) {
      setSelectionFrame(selectedShape, dragState.startSelectionFrame.map((item) => ({
        x: item.x + dx,
        y: item.y + dy
      })));
    }
  }
  propagateShapeTopologyLinks(selectedShape);
  dragState.linkedShapeSnapshots?.forEach(({ shape, snapshot }) => {
    moveShapeFromSnapshot(shape, snapshot, null, dx, dy);
  });
}

function resizeRectangleSide(point) {
  if (selectedShape.dataset.rectangle === "true") {
    resizeRotatedRectangleSide(point);
    return;
  }

  const start = dragState.startAttributes;
  const right = start.x + start.width;
  const bottom = start.y + start.height;

  if (dragState.index === 0) {
    const y = clamp(point.y, EDGE_MARGIN, bottom - MIN_SIZE);
    selectedShape.setAttribute("y", y);
    selectedShape.setAttribute("height", bottom - y);
  } else if (dragState.index === 1) {
    const x = clamp(point.x, start.x + MIN_SIZE, WORKSPACE_SIZE - EDGE_MARGIN);
    selectedShape.setAttribute("width", x - start.x);
  } else if (dragState.index === 2) {
    const y = clamp(point.y, start.y + MIN_SIZE, WORKSPACE_SIZE - EDGE_MARGIN);
    selectedShape.setAttribute("height", y - start.y);
  } else if (dragState.index === 3) {
    const x = clamp(point.x, EDGE_MARGIN, right - MIN_SIZE);
    selectedShape.setAttribute("x", x);
    selectedShape.setAttribute("width", right - x);
  }
}

function resizeRectangleCorner(point) {
  const frame = dragState.startSelectionFrame;
  if (!frame || frame.length !== 4) {
    return;
  }

  const cornerIndex = dragState.index;
  const oppositeIndex = (cornerIndex + 2) % 4;
  const corner = frame[cornerIndex];
  const opposite = frame[oppositeIndex];
  const diagonal = {
    x: corner.x - opposite.x,
    y: corner.y - opposite.y
  };
  const diagonalLengthSquared = diagonal.x ** 2 + diagonal.y ** 2;
  if (diagonalLengthSquared < 0.01) {
    return;
  }

  const pointerVector = {
    x: point.x - opposite.x,
    y: point.y - opposite.y
  };
  const wantedScale = (
    pointerVector.x * diagonal.x + pointerVector.y * diagonal.y
  ) / diagonalLengthSquared;
  const minimumDimension = Math.min(
    distance(frame[0], frame[1]),
    distance(frame[1], frame[2])
  );
  const minimumScale = MIN_SIZE / Math.max(minimumDimension, 0.01);
  const scale = Math.max(wantedScale, minimumScale);
  const nextFrame = frame.map((item) => ({
    x: opposite.x + (item.x - opposite.x) * scale,
    y: opposite.y + (item.y - opposite.y) * scale
  }));

  if (!pointsAreInsideWorkspace(nextFrame)) {
    return;
  }

  if (selectedShape.dataset.kind === "rect") {
    const xs = nextFrame.map((item) => item.x);
    const ys = nextFrame.map((item) => item.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    selectedShape.setAttribute("x", x);
    selectedShape.setAttribute("y", y);
    selectedShape.setAttribute("width", Math.max(...xs) - x);
    selectedShape.setAttribute("height", Math.max(...ys) - y);
  } else if (selectedShape.dataset.rectangle === "true") {
    selectedShape.setAttribute(
      "points",
      pointsToAttribute([...nextFrame, { ...nextFrame[0] }])
    );
    setSelectionFrame(selectedShape, nextFrame);
  }
  propagateDraggedTopologyPoint(nextFrame[cornerIndex]);
}

function resizeRotatedRectangleSide(point) {
  const frame = dragState.startSelectionFrame;
  if (!frame || frame.length !== 4) {
    return;
  }

  const horizontalLength = distance(frame[0], frame[1]);
  const verticalLength = distance(frame[0], frame[3]);
  if (horizontalLength < 0.01 || verticalLength < 0.01) {
    return;
  }

  const horizontalAxis = {
    x: (frame[1].x - frame[0].x) / horizontalLength,
    y: (frame[1].y - frame[0].y) / horizontalLength
  };
  const verticalAxis = {
    x: (frame[3].x - frame[0].x) / verticalLength,
    y: (frame[3].y - frame[0].y) / verticalLength
  };
  const projection = (from, to, axis) =>
    (to.x - from.x) * axis.x + (to.y - from.y) * axis.y;
  const offset = (origin, axis, amount) => ({
    x: origin.x + axis.x * amount,
    y: origin.y + axis.y * amount
  });

  const nextFrame = frame.map((item) => ({ ...item }));

  if (dragState.index === 0) {
    const height = Math.max(
      MIN_SIZE,
      -projection(frame[3], point, verticalAxis)
    );
    nextFrame[0] = offset(frame[3], verticalAxis, -height);
    nextFrame[1] = offset(frame[2], verticalAxis, -height);
  } else if (dragState.index === 1) {
    const width = Math.max(
      MIN_SIZE,
      projection(frame[0], point, horizontalAxis)
    );
    nextFrame[1] = offset(frame[0], horizontalAxis, width);
    nextFrame[2] = offset(frame[3], horizontalAxis, width);
  } else if (dragState.index === 2) {
    const height = Math.max(
      MIN_SIZE,
      projection(frame[0], point, verticalAxis)
    );
    nextFrame[3] = offset(frame[0], verticalAxis, height);
    nextFrame[2] = offset(frame[1], verticalAxis, height);
  } else if (dragState.index === 3) {
    const width = Math.max(
      MIN_SIZE,
      -projection(frame[1], point, horizontalAxis)
    );
    nextFrame[0] = offset(frame[1], horizontalAxis, -width);
    nextFrame[3] = offset(frame[2], horizontalAxis, -width);
  }

  if (!pointsAreInsideWorkspace(nextFrame)) {
    return;
  }

  selectedShape.setAttribute(
    "points",
    pointsToAttribute([...nextFrame, { ...nextFrame[0] }])
  );
  setSelectionFrame(selectedShape, nextFrame);
}

function scaleSelectedShapeFromCorner(point) {
  const startFrame = dragState.startSelectionFrame;
  if (!startFrame) {
    return;
  }

  const center = getFrameCenter(startFrame);
  const startCorner = startFrame[dragState.index];
  const startDistance = distance(center, startCorner);
  const wantedScale = distance(center, point) / startDistance;
  const minimumDimension = Math.min(
    distance(startFrame[0], startFrame[1]),
    distance(startFrame[1], startFrame[2])
  );
  const minimumScale = MIN_SIZE / Math.max(minimumDimension, 0.01);
  const scale = Math.max(wantedScale, minimumScale);
  const points = dragState.startAttributes.points.map((item) => ({
    x: center.x + (item.x - center.x) * scale,
    y: center.y + (item.y - center.y) * scale
  }));

  if (!pointsAreInsideWorkspace(points)) {
    return;
  }

  const frame = startFrame.map((item) => ({
    x: center.x + (item.x - center.x) * scale,
    y: center.y + (item.y - center.y) * scale
  }));
  selectedShape.setAttribute("points", pointsToAttribute(points));
  setSelectionFrame(selectedShape, frame);
}

function resizeCircle(point) {
  const { cx, cy } = dragState.startAttributes;
  const maximumRadius = Math.min(
    cx - EDGE_MARGIN,
    cy - EDGE_MARGIN,
    WORKSPACE_SIZE - EDGE_MARGIN - cx,
    WORKSPACE_SIZE - EDGE_MARGIN - cy
  );
  const radius = clamp(distance({ x: cx, y: cy }, point), MIN_SIZE, maximumRadius);
  selectedShape.setAttribute("r", radius);
}

function resizeEllipseRadius(point) {
  const start = dragState.startAttributes;
  const center = { x: start.cx, y: start.cy };
  const localPoint = rotatePoint(point, center, -start.rotation);
  const changesHorizontalRadius = dragState.index === 0 || dragState.index === 2;
  const wantedRadius = Math.max(
    MIN_SIZE,
    changesHorizontalRadius
      ? Math.abs(localPoint.x - start.cx)
      : Math.abs(localPoint.y - start.cy)
  );
  const originalRadius = changesHorizontalRadius ? start.rx : start.ry;

  const applyRadius = (radius) => {
    selectedShape.setAttribute(changesHorizontalRadius ? "rx" : "ry", radius);
  };

  applyRadius(wantedRadius);
  if (ellipseIsInsideWorkspace(selectedShape)) {
    return;
  }

  let minimum = Math.min(originalRadius, wantedRadius);
  let maximum = Math.max(originalRadius, wantedRadius);
  applyRadius(minimum);

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (minimum + maximum) / 2;
    applyRadius(middle);
    if (ellipseIsInsideWorkspace(selectedShape)) {
      minimum = middle;
    } else {
      maximum = middle;
    }
  }
  applyRadius(minimum);
}

function scaleEllipseFromCorner(point) {
  const start = dragState.startAttributes;
  const center = { x: start.cx, y: start.cy };
  const localPoint = rotatePoint(point, center, -start.rotation);
  const cornerSigns = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 }
  ][dragState.index];
  const startCorner = {
    x: start.cx + cornerSigns.x * start.rx,
    y: start.cy + cornerSigns.y * start.ry
  };
  const startDistance = distance(center, startCorner);
  const wantedScale = distance(center, localPoint) / Math.max(startDistance, 0.01);
  const minimumScale = MIN_SIZE / Math.min(start.rx, start.ry);

  const applyScale = (scale) => {
    selectedShape.setAttribute("rx", start.rx * scale);
    selectedShape.setAttribute("ry", start.ry * scale);
  };

  const requestedScale = Math.max(wantedScale, minimumScale);
  applyScale(requestedScale);
  if (ellipseIsInsideWorkspace(selectedShape)) {
    return;
  }

  let minimum = minimumScale;
  let maximum = requestedScale;
  applyScale(minimum);
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (minimum + maximum) / 2;
    applyScale(middle);
    if (ellipseIsInsideWorkspace(selectedShape)) {
      minimum = middle;
    } else {
      maximum = middle;
    }
  }
  applyScale(minimum);
}

function resizeTextFromCorner(point) {
  const start = dragState.startAttributes;
  const frame = start.corners;
  const cornerIndex = dragState.index;
  const oppositeIndex = (cornerIndex + 2) % 4;
  const corner = frame[cornerIndex];
  const opposite = frame[oppositeIndex];
  const diagonal = {
    x: corner.x - opposite.x,
    y: corner.y - opposite.y
  };
  const diagonalLengthSquared = diagonal.x ** 2 + diagonal.y ** 2;
  if (diagonalLengthSquared < 0.01) {
    return;
  }

  const pointerVector = {
    x: point.x - opposite.x,
    y: point.y - opposite.y
  };
  const wantedScale = (
    pointerVector.x * diagonal.x + pointerVector.y * diagonal.y
  ) / diagonalLengthSquared;
  const minimumScale = 8 / start.fontSize;
  const maximumScale = 120 / start.fontSize;
  const scale = clamp(wantedScale, minimumScale, maximumScale);

  selectedShape.setAttribute("x", start.x);
  selectedShape.setAttribute("y", start.y);
  selectedShape.setAttribute("font-size", start.fontSize * scale);
  applyTextRotation(selectedShape);

  const resizedCorners = getTextRotatedCorners(selectedShape);
  const dx = opposite.x - resizedCorners[oppositeIndex].x;
  const dy = opposite.y - resizedCorners[oppositeIndex].y;
  selectedShape.setAttribute("x", start.x + dx);
  selectedShape.setAttribute("y", start.y + dy);
  applyTextRotation(selectedShape);

  if (!pointsAreInsideWorkspace(getTextRotatedCorners(selectedShape))) {
    selectedShape.setAttribute("x", start.x);
    selectedShape.setAttribute("y", start.y);
    selectedShape.setAttribute("font-size", start.fontSize);
    applyTextRotation(selectedShape);
    return;
  }

  textSizeInput.value = Math.round(start.fontSize * scale);
}

function moveLineEnd(point) {
  const start = dragState.startAttributes;
  const fixedPoint = dragState.index === 0
    ? { x: start.x2, y: start.y2 }
    : { x: start.x1, y: start.y1 };
  const originalMovingPoint = dragState.index === 0
    ? { x: start.x1, y: start.y1 }
    : { x: start.x2, y: start.y2 };
  const pointerPoint = {
    x: clamp(point.x, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN),
    y: clamp(point.y, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN)
  };
  const rawSnap = findSnapPointIncludingSegments(pointerPoint, selectedShape, [{
    point: fixedPoint,
    type: "same-shape-vertex",
    shape: selectedShape,
    vertexIndex: dragState.index === 0 ? 1 : 0
  }]);
  const snap = isDraggedLinkedSnap(rawSnap) ? null : rawSnap;
  let endPoint = snap ? { ...snap.point } : pointerPoint;
  dragState.activeSnap = snap;

  if (distance(fixedPoint, endPoint) < MIN_SIZE) {
    const originalLength = distance(fixedPoint, originalMovingPoint);
    endPoint = {
      x: fixedPoint.x + ((originalMovingPoint.x - fixedPoint.x) / originalLength) * MIN_SIZE,
      y: fixedPoint.y + ((originalMovingPoint.y - fixedPoint.y) / originalLength) * MIN_SIZE
    };
  }

  const suffix = dragState.index === 0 ? "1" : "2";
  selectedShape.setAttribute(`x${suffix}`, endPoint.x);
  selectedShape.setAttribute(`y${suffix}`, endPoint.y);
  propagateDraggedTopologyPoint(endPoint);
}

function moveArcPoint(point) {
  const start = dragState.startAttributes;
  const pointerPoint = {
    x: clamp(point.x, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN),
    y: clamp(point.y, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN)
  };
  const arcData = getArcData(selectedShape);
  const fixedArcPoint = dragState.index === 0 ? arcData.end : arcData.start;
  const rawSnap = findSnapPointIncludingSegments(pointerPoint, selectedShape, [{
    point: fixedArcPoint,
    type: "same-shape-vertex",
    shape: selectedShape,
    vertexIndex: dragState.index === 0 ? 1 : 0
  }]);
  const snap = isDraggedLinkedSnap(rawSnap) ? null : rawSnap;
  const nextPoint = snap ? { ...snap.point } : pointerPoint;
  dragState.activeSnap = snap;
  const arcStart = dragState.index === 0 ? nextPoint : start.start;
  const arcEnd = dragState.index === 1 ? nextPoint : start.end;
  if (distance(arcStart, arcEnd) < MIN_SIZE) {
    return;
  }
  const controlPoint = getArcControlAfterEndpointMove(
    start.start,
    start.end,
    start.through,
    arcStart,
    arcEnd
  );
  if (!getCircularArcGeometry(arcStart, arcEnd, controlPoint)
    || !isArcInsideWorkspace(
      arcStart,
      arcEnd,
      controlPoint,
      getArcStretch(selectedShape),
      getArcWidth(selectedShape)
    )) {
    return;
  }
  setArcData(selectedShape, arcStart, arcEnd, controlPoint);
  propagateDraggedTopologyPoint(nextPoint);
}

function moveArcBend(point) {
  const start = dragState.startAttributes;
  const displayedPointer = {
    x: clamp(point.x, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN),
    y: clamp(point.y, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN)
  };
  const pointer = getUnstretchedArcPoint(
    start.start,
    start.end,
    displayedPointer,
    start.stretch
  );
  const through = getArcControlPoint(start.start, start.end, pointer);
  if (!getCircularArcGeometry(start.start, start.end, through)
    || !isArcInsideWorkspace(
      start.start,
      start.end,
      through,
      start.stretch,
      start.width
    )) {
    return;
  }
  setArcData(selectedShape, start.start, start.end, through);
}

function resizeArcHeight(point) {
  const start = dragState.startAttributes;
  const chordLength = distance(start.start, start.end);

  if (chordLength < 0.01) {
    return;
  }

  const midpoint = {
    x: (start.start.x + start.end.x) / 2,
    y: (start.start.y + start.end.y) / 2
  };

  const normal = {
    x: -(start.end.y - start.start.y) / chordLength,
    y: (start.end.x - start.start.x) / chordLength
  };

  const displayedPoints = getDisplayedArcPoints(
    start.start,
    start.end,
    start.through,
    start.stretch,
    start.width
  );

  const displayedBend = getDisplayedArcControlPoint(
    start.start,
    start.end,
    start.through,
    start.stretch,
    start.width
  );

  const bendSide = Math.sign(
    (displayedBend.x - midpoint.x) * normal.x
    + (displayedBend.y - midpoint.y) * normal.y
  ) || 1;

  const outward = {
    x: normal.x * bendSide,
    y: normal.y * bendSide
  };

  const movement = (
    (point.x - dragState.startPoint.x) * outward.x
    + (point.y - dragState.startPoint.y) * outward.y
  );

  const originalExtent = Math.max(
    ...displayedPoints.map((item) => Math.abs(
      (item.x - midpoint.x) * normal.x
      + (item.y - midpoint.y) * normal.y
    ))
  );

  const wantedExtent = Math.max(MIN_SIZE / 2, originalExtent + movement);
  const stretch = Math.max(
    0.1,
    start.stretch * wantedExtent / Math.max(originalExtent, 0.01)
  );

  if (!isArcInsideWorkspace(
    start.start,
    start.end,
    start.through,
    stretch,
    start.width
  )) {
    return;
  }

  selectedShape.dataset.arcStretch = stretch;
  setArcData(selectedShape, start.start, start.end, start.through);
}

function scaleArcFromCorner(point) {
  const start = dragState.startAttributes;
  const frame = dragState.startSelectionFrame;
  if (!frame || frame.length !== 4) {
    return;
  }
  const cornerIndex = dragState.index;
  const opposite = frame[(cornerIndex + 2) % 4];
  const corner = frame[cornerIndex];
  const diagonal = {
    x: corner.x - opposite.x,
    y: corner.y - opposite.y
  };
  const diagonalLengthSquared = diagonal.x ** 2 + diagonal.y ** 2;
  if (diagonalLengthSquared < 0.01) {
    return;
  }
  const pointerVector = {
    x: point.x - opposite.x,
    y: point.y - opposite.y
  };
  const wantedScale = (
    pointerVector.x * diagonal.x
    + pointerVector.y * diagonal.y
  ) / diagonalLengthSquared;
  const minimumDimension = Math.min(
    distance(frame[0], frame[1]),
    distance(frame[1], frame[2])
  );
  const minimumScale = MIN_SIZE / Math.max(minimumDimension, 0.01);
  const scale = Math.max(wantedScale, minimumScale);
  const scalePoint = (source) => ({
    x: opposite.x + (source.x - opposite.x) * scale,
    y: opposite.y + (source.y - opposite.y) * scale
  });
  const arcStart = scalePoint(start.start);
  const arcEnd = scalePoint(start.end);
  const through = scalePoint(start.through);
  if (!isArcInsideWorkspace(
    arcStart,
    arcEnd,
    through,
    start.stretch,
    start.width
  )) {
    return;
  }
  selectedShape.dataset.arcStretch = start.stretch;
  selectedShape.dataset.arcWidth = start.width;
  setArcData(selectedShape, arcStart, arcEnd, through);
}

function movePolygonVertex(point) {
  const points = dragState.startAttributes.points.map((item) => ({ ...item }));
  const pointerPoint = {
    x: clamp(point.x, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN),
    y: clamp(point.y, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN)
  };
  const sameShapeCandidates = points
    .map((candidate, index) => ({
      point: candidate,
      type: "same-shape-vertex",
      shape: selectedShape,
      vertexIndex: index
    }))
    .filter((candidate) => candidate.vertexIndex !== dragState.index);
  const previousSegmentIndex = (
    dragState.index - 1 + points.length
  ) % points.length;
  const rawSnap = findSnapPointIncludingSegments(
    pointerPoint,
    selectedShape,
    sameShapeCandidates,
    [previousSegmentIndex, dragState.index]
  );
  const snap = isDraggedLinkedSnap(rawSnap) ? null : rawSnap;
  points[dragState.index] = snap ? { ...snap.point } : pointerPoint;
  dragState.activeSnap = snap;

  const xs = points.map((item) => item.x);
  const ys = points.map((item) => item.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  if (width >= MIN_SIZE && height >= MIN_SIZE) {
    selectedShape.setAttribute("points", pointsToAttribute(points));
    selectedShape.removeAttribute("data-selection-frame");
    propagateDraggedTopologyPoint(points[dragState.index]);
  }
}

function movePenPoint(point) {
  const points = dragState.startAttributes.points.map((item) => ({ ...item }));
  const pointerPoint = {
    x: clamp(point.x, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN),
    y: clamp(point.y, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN)
  };
  const lastIndex = points.length - 1;
  const canClose = points.length >= 3;
  const isClosedPen = selectedShape.dataset.closed === "true";
  const isOpenEndpoint = !isClosedPen
    && (dragState.index === 0 || dragState.index === lastIndex);
  const oppositeIndex = dragState.index === 0 ? lastIndex : 0;
  const sameShapeCandidates = points
    .map((candidate, index) => ({
      point: candidate,
      type: index === oppositeIndex && isOpenEndpoint && canClose
        ? "pen-close"
        : "same-shape-vertex",
      shape: selectedShape,
      vertexIndex: index
    }))
    .filter((candidate) => {
      if (candidate.vertexIndex === dragState.index) {
        return false;
      }
      return canClose || candidate.vertexIndex !== oppositeIndex;
    });
  const adjacentSegments = [
    dragState.index - 1,
    dragState.index
  ].filter((index) => index >= 0 && index < points.length - 1);
  const rawSnap = isClosedPen
    ? null
    : findSnapPointIncludingSegments(
      pointerPoint,
      selectedShape,
      sameShapeCandidates,
      adjacentSegments
    );
  const snap = isDraggedLinkedSnap(rawSnap) ? null : rawSnap;
  const movedPoint = snap ? { ...snap.point } : pointerPoint;
  dragState.activeSnap = snap;
  points[dragState.index] = movedPoint;

  if (getPointsExtent(points) >= MIN_SIZE) {
    selectedShape.setAttribute("points", pointsToAttribute(points));
    selectedShape.removeAttribute("data-selection-frame");
    propagateDraggedTopologyPoint(movedPoint);
  }
}

function movePencilEnd(point) {
  const points = dragState.pencilExtensionPoints;
  const pointerPoint = {
    x: clamp(point.x, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN),
    y: clamp(point.y, EDGE_MARGIN, WORKSPACE_SIZE - EDGE_MARGIN)
  };
  if (distance(points[points.length - 1], pointerPoint) >= 2) {
    points.push(pointerPoint);
  }

  const oppositeIndex = 0;
  const snap = findSnapPoint(
    pointerPoint,
    selectedShape,
    [{
      point: points[oppositeIndex],
      type: "pencil-close",
      shape: selectedShape,
      vertexIndex: oppositeIndex
    }]
  );
  if (snap) {
    points[points.length - 1] = { ...snap.point };
  }
  dragState.activeSnap = snap;
  selectedShape.setAttribute("points", pointsToAttribute(points));
  selectedShape.removeAttribute("data-selection-frame");
}

function closePencilPathIfSnapped() {
  if (!selectedShape
    || selectedShape.dataset.kind !== "pencil"
    || selectedShape.dataset.closed === "true"
    || dragState?.type !== "pencil-end"
    || dragState.activeSnap?.type !== "pencil-close") {
    return false;
  }

  const points = getElementPoints(selectedShape);
  const closingPoint = { ...dragState.activeSnap.point };
  points[0] = closingPoint;
  points[points.length - 1] = { ...closingPoint };
  selectedShape.setAttribute("points", pointsToAttribute(points));
  selectedShape.dataset.closed = "true";
  selectedPenPointIndex = null;
  return true;
}

function finishPencilEndExtension() {
  if (!selectedShape
    || selectedShape.dataset.kind !== "pencil"
    || dragState?.type !== "pencil-end"
    || !dragState.pencilExtensionPoints) {
    return;
  }

  const points = dragState.pencilExtensionPoints;
  const startIndex = dragState.pencilExtensionStartIndex;
  const originalPart = points.slice(0, startIndex);
  const extensionPart = points.slice(startIndex);
  if (extensionPart.length < 2) {
    return;
  }
  const simplifiedExtension = simplifyPencilPoints(
    extensionPart,
    getPencilSimplifyTolerance(extensionPart)
  );
  selectedShape.setAttribute(
    "points",
    pointsToAttribute([...originalPart, ...simplifiedExtension])
  );
}

function closeOpenPenPathIfSnapped() {
  if (!selectedShape
    || selectedShape.dataset.kind !== "pen"
    || selectedShape.dataset.closed === "true"
    || !dragState
    || dragState.type !== "pen-point") {
    return false;
  }

  const points = getElementPoints(selectedShape);
  const lastIndex = points.length - 1;
  if (points.length < 3 || (dragState.index !== 0 && dragState.index !== lastIndex)) {
    return false;
  }

  const oppositeIndex = dragState.index === 0 ? lastIndex : 0;
  if (distance(points[dragState.index], points[oppositeIndex]) > getSnapDistance()) {
    return false;
  }

  const snapPoint = { ...points[oppositeIndex] };
  if (dragState.index === 0) {
    points[0] = snapPoint;
  } else {
    points[lastIndex] = snapPoint;
  }

  const closedShape = replaceWithPenPath(selectedShape, points, true);
  if (!closedShape) {
    return false;
  }

  selectedShape = closedShape;
  selectedShapes = [closedShape];
  selectedPenPointIndex = 0;
  dragState.activeSnap = null;
  renderHandles();
  return true;
}

function separateSelectedPenPoints() {
  if (!selectedShape || selectedPenPointIndex === null) {
    return;
  }

  const selectedTopologyPoint = getSelectedTopologyPoint();
  if (selectedTopologyPoint
    && getLinkedTopologyVertices(
      selectedTopologyPoint.shape,
      selectedTopologyPoint.index,
      selectedTopologyPoint.point
    ).length) {
    detachTopologyPoint(selectedTopologyPoint.shape, selectedTopologyPoint.index);
    selectedPenPointIndex = null;
    recordHistory();
    selectShape(selectedTopologyPoint.shape);
    return;
  }

  if (selectedShape.dataset.kind === "arc"
    && (selectedPenPointIndex === 0 || selectedPenPointIndex === 1)) {
    const arc = selectedShape;
    const endpointIndex = selectedPenPointIndex;
    detachTopologyPoint(arc, endpointIndex);
    selectedPenPointIndex = null;
    recordHistory();
    selectShape(arc);
    return;
  }

  const data = getEditablePathData(selectedShape);
  if (!data) {
    return;
  }

  if (!data.closed) {
    if (selectedPenPointIndex <= 0
      || selectedPenPointIndex >= data.points.length - 1) {
      return;
    }

    const splitPoint = { ...data.points[selectedPenPointIndex] };
    const firstPart = [
      ...data.points.slice(0, selectedPenPointIndex),
      splitPoint
    ];
    const secondPart = [
      { ...splitPoint },
      ...data.points.slice(selectedPenPointIndex + 1)
    ];
    const insertionPoint = selectedShape.nextSibling;
    selectedShape.remove();

    const firstShape = createOpenPath(firstPart);
    const secondShape = createOpenPath(secondPart);
    if (firstShape) {
      drawingLayer.insertBefore(firstShape, insertionPoint);
    }
    if (secondShape) {
      drawingLayer.insertBefore(secondShape, insertionPoint);
    }

    selectedPenPointIndex = null;
    selectShape(secondShape || firstShape);
    recordHistory();
    return;
  }

  const closedPoints = data.points;
  const uniquePoints = closedPoints.slice(0, -1);
  if (!uniquePoints.length) {
    return;
  }

  const splitIndex = selectedPenPointIndex === closedPoints.length - 1
    ? 0
    : selectedPenPointIndex;
  const points = [
    ...uniquePoints.slice(splitIndex),
    ...uniquePoints.slice(0, splitIndex + 1)
  ];

  const openedShape = replaceWithPenPath(selectedShape, points, false);
  if (!openedShape) {
    return;
  }

  selectedShape = openedShape;
  selectedShapes = [openedShape];
  selectedPenPointIndex = points.length - 1;
  renderHandles();
  recordHistory();
}

function joinSelectedPencilPaths() {
  const target = getSelectedPencilJoinTarget();
  if (!target || !selectedShape) {
    return;
  }

  const selectedPoints = getElementPoints(selectedShape);
  if (target.shape === selectedShape) {
    const closingPoint = selectedPenPointIndex === 0
      ? { ...selectedPoints[selectedPoints.length - 1] }
      : { ...selectedPoints[0] };
    selectedPoints[0] = closingPoint;
    selectedPoints[selectedPoints.length - 1] = { ...closingPoint };
    selectedShape.setAttribute("points", pointsToAttribute(selectedPoints));
    selectedShape.dataset.closed = "true";
    selectedPenPointIndex = null;
    renderHandles();
    recordHistory();
    return;
  }

  const targetPoints = getElementPoints(target.shape);
  const selectedOriented = selectedPenPointIndex === 0
    ? [...selectedPoints].reverse()
    : selectedPoints;
  const targetOriented = target.endpointIndex === 0
    ? targetPoints
    : [...targetPoints].reverse();
  selectedOriented[selectedOriented.length - 1] = { ...target.point };
  const mergedPoints = [
    ...selectedOriented,
    ...targetOriented.slice(1)
  ];

  selectedShape.remove();
  target.shape.remove();
  const mergedShape = createOpenPath(mergedPoints);
  mergedShape.dataset.kind = "pencil";
  drawingLayer.append(mergedShape);

  selectedPenPointIndex = null;
  selectShape(mergedShape);
  recordHistory();
}

function deleteSelected() {
  if (!selectedShapes.length) {
    return;
  }
  const deletedCount = selectedShapes.length;
  selectedShapes.forEach((shape) => shape.remove());
  selectShapes([]);
  recordHistory();
}

function createExportedSvgSource() {
  const exportedSvg = createSvgElement("svg", {
    xmlns: SVG_NS,
    width: WORKSPACE_SIZE,
    height: WORKSPACE_SIZE,
    viewBox: `0 0 ${WORKSPACE_SIZE} ${WORKSPACE_SIZE}`
  });

  [...drawingLayer.children].forEach((shape) => {
    const clone = shape.cloneNode(true);
    clone.removeAttribute("class");
    clone.removeAttribute("data-kind");
    clone.removeAttribute("data-closed");
    clone.removeAttribute("data-rotation");
    clone.removeAttribute("data-selection-frame");
    clone.removeAttribute("data-rectangle");
    clone.removeAttribute("data-arc-start");
    clone.removeAttribute("data-arc-end");
    clone.removeAttribute("data-arc-through");
    clone.removeAttribute("data-arc-stretch");
    clone.removeAttribute("data-arc-width");
    clone.removeAttribute("data-detached-topology");
    exportedSvg.append(clone);
  });

  return new XMLSerializer().serializeToString(exportedSvg);
}

function downloadSvg() {
  const source = createExportedSvgSource();
  const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "disegno.svg";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function openSaveDialog() {
  saveFileNameInput.value = "";
  saveNameError.textContent = "";
  confirmSaveButton.disabled = true;
  saveDialog.showModal();
  window.setTimeout(() => saveFileNameInput.focus(), 0);
}

function normalizeFileName(value) {
  return value.trim().replace(/\.svg$/i, "");
}

function updateSaveConfirmation() {
  const name = normalizeFileName(saveFileNameInput.value);
  confirmSaveButton.disabled = !name;
  saveNameError.textContent = saveFileNameInput.value && !name
    ? "Inserisci almeno un carattere nel nome."
    : "";
}

async function confirmSaveSvg(event) {
  event.preventDefault();
  const name = normalizeFileName(saveFileNameInput.value);
  if (!name) {
    updateSaveConfirmation();
    return;
  }

  const previousButtonText = confirmSaveButton.textContent;
  confirmSaveButton.disabled = true;
  confirmSaveButton.textContent = "Salvataggio...";
  saveNameError.textContent = "";

  try {
    const response = await fetch("/wp-json/rcr/v1/easysvglab/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        filename: `${name}.svg`,
        svg: createExportedSvgSource()
      })
    });

    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      const message = result?.message || "Non è stato possibile salvare il file sul sito.";
      throw new Error(message);
    }

    saveDialog.close();
    window.alert(`File salvato: ${result?.filename || `${name}.svg`}`);
  } catch (error) {
    saveNameError.textContent = error.message || "Errore durante il salvataggio.";
    confirmSaveButton.disabled = false;
  } finally {
    confirmSaveButton.textContent = previousButtonText;
  }
}

measurementEditorForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  applyMeasurementEditorValue();
});

measurementValueInput?.addEventListener("change", () => {
  applyMeasurementEditorValue();
});

measurementValueInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    activeMeasurement = null;
    closeMeasurementEditor();
    renderMeasurementControls();
  }
});

toolButtons.forEach((button) => {
  button.addEventListener("click", () => setActiveTool(button.dataset.tool));
});

workspace.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }

  if (activeTool === "eraser") {
    const point = getSvgPoint(event);
    dragState = {
      type: "eraser",
      lastPoint: point,
      changed: erasePencilSegment(point, point)
    };
    workspace.setPointerCapture(event.pointerId);
    renderEraserPreview(point);
    return;
  }

  const measurementTarget = event.target.closest("[data-measure-kind]");
  if (activeTool === "measure" && measurementTarget) {
    event.preventDefault();
    handleMeasurementControl(measurementTarget);
    return;
  }

  const edgeTarget = event.target.closest("[data-edge-index]");
  if (activeTool === "delete-edge" && edgeTarget) {
    const shape = drawingLayer.children[Number(edgeTarget.dataset.shapeIndex)];
    if (shape) {
      deleteEdge(shape, Number(edgeTarget.dataset.edgeIndex));
    }
    return;
  }

  const addPointTarget = event.target.closest("[data-add-edge-index]");
  if (activeTool === "add-point" && addPointTarget) {
    const shape = drawingLayer.children[Number(addPointTarget.dataset.shapeIndex)];
    if (shape) {
      addPointToShape(shape, Number(addPointTarget.dataset.addEdgeIndex), getSvgPoint(event));
    }
    return;
  }

  const hoverMoveHandle = event.target.closest("[data-hover-move]");
  if (activeTool === "select" && hoverMoveHandle) {
    const shape = drawingLayer.children[Number(hoverMoveHandle.dataset.hoverMove)];
    if (shape) {
      if (event.shiftKey) {
        toggleShapeSelection(shape);
      } else {
        selectShape(shape);
        const moveHandle = handlesLayer.querySelector('[data-handle="move"]');
        startHandleDrag(moveHandle, event);
      }
    }
    return;
  }

  const handle = event.target.closest("[data-handle]");
  if (activeTool === "select" && handle?.dataset.handle === "rotate") {
    const rotationSourceShape = selectedShape
      || drawingLayer.children[Number(handle.dataset.shapeSource)];

    if (rotationSourceShape && drawingLayer.contains(rotationSourceShape)) {
      const connectedShapes = getConnectedShapeComponent(rotationSourceShape);
      const selectionMissesConnectedShape = connectedShapes.some((shape) =>
        !selectedShapes.includes(shape)
      );

      if (connectedShapes.length > 1 && selectionMissesConnectedShape) {
        selectShapes(connectedShapes, rotationSourceShape);
      }
    }

    if (selectedShapes.length > 1) {
      event.preventDefault();
      startGroupRotate(event);
      return;
    }
  }
  if (activeTool === "select" && handle?.dataset.handle === "group-move"
    && selectedShapes.length > 1) {
    event.preventDefault();
    startGroupMove(event);
    return;
  }

  if (activeTool === "select" && handle?.dataset.handle === "group-scale"
    && selectedShapes.length > 1) {
    event.preventDefault();
    startGroupScale(event, handle);
    return;
  }

  if (activeTool === "select"
    && handle
    && selectedShapes.length > 1
    && !["group-move", "rotate"].includes(handle.dataset.handle)) {
    const sourceShape = drawingLayer.children[
      Number(handle.dataset.shapeSource)
    ];
    if (sourceShape && selectedShapes.includes(sourceShape)) {
      selectedShape = sourceShape;
    }
  }
  if (activeTool === "select" && handle && selectedShape) {
    event.preventDefault();
    if (event.shiftKey) {
      toggleShapeSelection(selectedShape);
      return;
    }
    if (handle.dataset.handle === "pen-point"
      || handle.dataset.handle === "polygon-vertex"
      || handle.dataset.handle === "rect-vertex"
      || handle.dataset.handle === "arc-point"
      || handle.dataset.handle === "pencil-end") {
      selectedPenPointIndex = Number(handle.dataset.index);
      renderHandles();
      updateGuidePanel();
    }
    if (handle.dataset.handle === "pencil-end"
      && getSelectedPencilJoinTarget()) {
      return;
    }
    startHandleDrag(handle, event);
    return;
  }

  const selectionHit = event.target.closest(".selection-hit");
  const shape = selectionHit
    ? drawingLayer.children[Number(selectionHit.dataset.shapeIndex)]
    : event.target.closest(".drawable");
  const point = getSvgPoint(event);

  if (activeTool === "select") {
    if (shape) {
      if (event.shiftKey) {
        toggleShapeSelection(shape);
      } else {
        selectShape(shape);
      }
    } else {
      startMarqueeSelection(point, event.pointerId);
    }
  } else if (activeTool === "measure") {
    if (shape) {
      if (shape !== selectedShape) {
        activeMeasurement = null;
        closeMeasurementEditor();
      }
      selectShape(shape);
      renderMeasurementControls();
    } else {
      activeMeasurement = null;
      closeMeasurementEditor();
      selectShape(null);
      setActiveTool("select");
    }
  } else if (activeTool === "rect") {
    createRectangle(point);
  } else if (activeTool === "circle") {
    createCircle(point);
  } else if (activeTool === "ellipse") {
    createEllipse(point);
  } else if (activeTool === "line") {
    if (!lineStartPoint) {
      beginLine(point);
    } else {
      finishLine(point);
    }
  } else if (activeTool === "arc") {
    if (!arcStartPoint) {
      beginArc(point);
    } else if (!arcEndPoint) {
      setArcEnd(point);
    } else {
      finishArc(point);
    }
  } else if (activeTool === "text") {
    createText(point);
  } else if (activeTool === "polygon") {
    createPolygon(point);
  } else if (activeTool === "pen") {
    if (!penShape) {
      beginPenPath(point);
    } else {
      addPenPoint(point);
    }
  } else if (activeTool === "pencil") {
    beginPencilPath(point, event.pointerId);
  } else if (activeTool === "delete-edge") {
  } else if (activeTool === "add-point") {
  }
});

workspace.addEventListener("pointermove", (event) => {
  if (activeTool === "eraser") {
    const point = getSvgPoint(event);
    if (dragState?.type === "eraser") {
      dragState.changed = erasePencilSegment(dragState.lastPoint, point)
        || dragState.changed;
      dragState.lastPoint = point;
    }
    renderEraserPreview(point);
    return;
  }

  if (dragState?.type === "marquee") {
    dragState.currentPoint = getSvgPoint(event);
    renderMarqueeSelection();
    return;
  }

  updateHoveredShape(event.target);

  if (!dragState
    && !lineStartPoint
    && !arcStartPoint
    && !penShape
    && !pencilShape
    && ["line", "arc", "pen", "pencil"].includes(activeTool)) {
    const point = getSvgPoint(event);
    const snap = activeTool === "pen"
      ? findSnapPointIncludingSegments(point)
      : findSnapPoint(point);
    handlesLayer.replaceChildren();
    renderSnapVertices(snap);
    return;
  }

  if (lineStartPoint) {
    linePreviewPoint = getSvgPoint(event);
    renderLineDraft();
    return;
  }

  if (arcStartPoint) {
    arcPreviewPoint = getSvgPoint(event);
    renderArcDraft();
    return;
  }

  if (penShape) {
    penPreviewPoint = getSvgPoint(event);
    renderPenDraft();
    return;
  }

  if (pencilShape) {
    const rawPoint = getRawSvgPoint(event);
    const isInside = rawPoint.x >= EDGE_MARGIN
      && rawPoint.x <= WORKSPACE_SIZE - EDGE_MARGIN
      && rawPoint.y >= EDGE_MARGIN
      && rawPoint.y <= WORKSPACE_SIZE - EDGE_MARGIN;
    if (isInside) {
      const pointerPoint = { x: rawPoint.x, y: rawPoint.y };
      continuePencilPath(pointerPoint);
      const points = pencilShape._drawingPoints;
      const canClose = points.length >= 3
        && getPointsExtent(points) >= MIN_SIZE;
      const snap = findSnapPoint(
        pointerPoint,
        pencilShape,
        canClose
          ? [{
            point: points[0],
            type: "pencil-close",
            shape: pencilShape,
            vertexIndex: 0
          }]
          : []
      );
      handlesLayer.replaceChildren();
      if (snap) {
        const lastPoint = points[points.length - 1];
        if (distance(lastPoint, snap.point) > 0.5) {
          handlesLayer.append(createSvgElement("line", {
            x1: lastPoint.x,
            y1: lastPoint.y,
            x2: snap.point.x,
            y2: snap.point.y,
            class: "pen-preview"
          }));
        }
      }
      renderSnapVertices(snap);
    }
    return;
  }
  if (!dragState || (!selectedShape
    && dragState.type !== "group-move"
    && dragState.type !== "group-scale"
    && dragState.type !== "group-rotate")) {
    return;
  }

  const point = getSvgPoint(event);
  if (dragState.type === "group-move") {
    moveSelectedGroup(point);
  } else if (dragState.type === "group-scale") {
    scaleSelectedGroup(point);
  } else if (dragState.type === "group-rotate") {
    const currentAngle = Math.atan2(
      point.y - dragState.rotationCenter.y,
      point.x - dragState.rotationCenter.x
    );
    let angleDifference = (currentAngle - dragState.previousAngle) * 180 / Math.PI;
    if (angleDifference > 180) {
      angleDifference -= 360;
    } else if (angleDifference < -180) {
      angleDifference += 360;
    }
    if (Math.abs(angleDifference) >= 0.1) {
      rotateSelectedGroup(angleDifference);
      dragState.previousAngle = currentAngle;
    }
  } else if (dragState.type === "move") {
    moveSelectedShape(point);
  } else if (dragState.type === "rect-side") {
    resizeRectangleSide(point);
  } else if (dragState.type === "rect-vertex") {
    resizeRectangleCorner(point);
  } else if (dragState.type === "box-scale") {
    scaleSelectedShapeFromCorner(point);
  } else if (dragState.type === "circle-radius") {
    resizeCircle(point);
  } else if (dragState.type === "ellipse-radius") {
    resizeEllipseRadius(point);
  } else if (dragState.type === "ellipse-scale") {
    scaleEllipseFromCorner(point);
  } else if (dragState.type === "text-scale") {
    resizeTextFromCorner(point);
  } else if (dragState.type === "line-end") {
    moveLineEnd(point);
  } else if (dragState.type === "arc-point") {
    moveArcPoint(point);
  } else if (dragState.type === "arc-bend") {
    moveArcBend(point);
  } else if (dragState.type === "arc-height") {
    resizeArcHeight(point);
  } else if (dragState.type === "arc-scale") {
    scaleArcFromCorner(point);
  } else if (dragState.type === "polygon-vertex") {
    movePolygonVertex(point);
  } else if (dragState.type === "pen-point") {
    movePenPoint(point);
  } else if (dragState.type === "pencil-end") {
    movePencilEnd(point);
  } else if (dragState.type === "rotate") {
    const currentAngle = Math.atan2(
      point.y - dragState.rotationCenter.y,
      point.x - dragState.rotationCenter.x
    );
    let angleDifference = (currentAngle - dragState.previousAngle) * 180 / Math.PI;
    if (angleDifference > 180) {
      angleDifference -= 360;
    } else if (angleDifference < -180) {
      angleDifference += 360;
    }
    if (Math.abs(angleDifference) >= 0.1) {
      dragState.linkedShapeSnapshots?.forEach(({ shape, snapshot }) => {
        rotateShapeFromSnapshot(shape, snapshot, angleDifference, dragState.rotationCenter);
      });
      rotateSelectedShape(angleDifference, false, dragState.rotationCenter);
      dragState.previousAngle = currentAngle;
    }
  }
  if (dragState && selectedShapes.length > 1
    && !["group-move", "group-scale", "group-rotate"].includes(dragState.type)) {
    updateGroupSelectionFrameFromCurrentGeometry();
  }

  if (dragState?.type !== "rotate") {
    renderHandles();
    if (dragState?.activeSnap) {
      renderSnapVertices(dragState.activeSnap, selectedShape);
    }
  }
});

workspace.addEventListener("pointerleave", () => {
  if (activeTool === "eraser" && dragState?.type !== "eraser") {
    handlesLayer.replaceChildren();
    return;
  }
  if (activeTool === "select" && !dragState && hoveredShape) {
    hoveredShape = null;
    renderHandles();
  }
});

window.addEventListener("resize", updateSeparatePointsButton);

workspace.addEventListener("pointerup", (event) => {
  if (pencilShape) {
    finishPencilPath(getSvgPoint(event));
  }
  if (dragState?.type === "eraser") {
    const changed = dragState.changed;
    dragState = null;
    renderEraserPreview(getSvgPoint(event));
    if (changed) {
      recordHistory();
    }
    return;
  }
  if (dragState?.type === "marquee") {
    finishMarqueeSelection();
    dragState = null;
    return;
  }
  if (dragState) {
    const finishedGroupFrame = dragState.type.startsWith("group-") && groupSelectionFrame
      ? groupSelectionFrame.map((point) => ({ ...point }))
      : null;
    let insertedTopologyPoint = null;
    if (!dragState.type.startsWith("group-")) {
      finishPencilEndExtension();
      if (!closePencilPathIfSnapped()) {
        closeOpenPenPathIfSnapped();
      }
      insertedTopologyPoint = materializeDraggedSegmentSnap();
    }
    const reconnectedTopology = insertedTopologyPoint
      ? (
        attachTopologyPoint(selectedShape, dragState.index),
        attachTopologyPoint(
          insertedTopologyPoint.shape,
          insertedTopologyPoint.vertexIndex
        ),
        true
      )
      : reconnectDraggedTopologySnap();
    const joinedTopologyVertex = dragState.activeSnap?.type === "vertex";
    const mergedRectangleShape = mergeRectangleJoinedToPen(
      dragState.activeSnap,
      dragState.type,
      selectedShape,
      dragState.index
    );
    if (mergedRectangleShape) {
      selectedShape = mergedRectangleShape;
      selectedShapes = [mergedRectangleShape];
      selectedPenPointIndex = null;
    }

    dragState = null;
    recordHistory();
    if (finishedGroupFrame && selectedShapes.length > 1) {
      groupSelectionFrame = finishedGroupFrame;
      storeGroupSelectionFrame(selectedShapes, groupSelectionFrame);
    }
    if (reconnectedTopology && selectedShape) {
      selectShape(selectedShape);
    } else {
      renderHandles();
    }
    if (insertedTopologyPoint) {
    } else if (mergedRectangleShape) {
    } else if (joinedTopologyVertex) {
    }
  }
});

workspace.addEventListener("pointercancel", (event) => {
  if (pencilShape) {
    finishPencilPath(getSvgPoint(event));
  }
  if (dragState?.type === "eraser") {
    const changed = dragState.changed;
    dragState = null;
    handlesLayer.replaceChildren();
    if (changed) {
      recordHistory();
    }
    return;
  }
  if (dragState?.type === "marquee") {
    selectShapes([]);
    dragState = null;
    return;
  }
  if (dragState) {
    let insertedTopologyPoint = null;
    if (!dragState.type.startsWith("group-")) {
      finishPencilEndExtension();
      if (!closePencilPathIfSnapped()) {
        closeOpenPenPathIfSnapped();
      }
      insertedTopologyPoint = materializeDraggedSegmentSnap();
    }
    const reconnectedTopology = insertedTopologyPoint
      ? (
        attachTopologyPoint(selectedShape, dragState.index),
        attachTopologyPoint(
          insertedTopologyPoint.shape,
          insertedTopologyPoint.vertexIndex
        ),
        true
      )
      : reconnectDraggedTopologySnap();
    const joinedTopologyVertex = dragState.activeSnap?.type === "vertex";
    const mergedRectangleShape = mergeRectangleJoinedToPen(
      dragState.activeSnap,
      dragState.type,
      selectedShape,
      dragState.index
    );
    if (mergedRectangleShape) {
      selectedShape = mergedRectangleShape;
      selectedShapes = [mergedRectangleShape];
      selectedPenPointIndex = null;
    }

    dragState = null;
    recordHistory();
    if (reconnectedTopology && selectedShape) {
      selectShape(selectedShape);
    } else {
      renderHandles();
    }
    if (insertedTopologyPoint) {
    } else if (mergedRectangleShape) {
    } else if (joinedTopologyVertex) {
    }
  }
});

workspace.addEventListener("wheel", (event) => {
  if (!event.shiftKey) {
    return;
  }

  event.preventDefault();
  const wheelDelta = event.deltaY || event.deltaX;
  if (!wheelDelta) {
    return;
  }
  const direction = wheelDelta < 0 ? 1 : -1;
  updateCanvasZoom(canvasZoom + direction * CANVAS_ZOOM_STEP);
}, { passive: false });

workspace.addEventListener("dblclick", (event) => {
  if (activeTool === "pen" && penShape) {
    event.preventDefault();
    finishPenPath();
  }
});

document.addEventListener("keydown", (event) => {
  const isEditingInput = event.target.matches("input");
  const hasCommandKey = event.ctrlKey || event.metaKey;
  const isReloadShortcut = event.key === "F5"
    || (hasCommandKey && event.key.toLowerCase() === "r");

  if (isReloadShortcut) {
    event.preventDefault();
    saveDrawingLocally();
  } else if (!isEditingInput && hasCommandKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (event.shiftKey) {
      redo();
    } else {
      undo();
    }
  } else if (!isEditingInput && hasCommandKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    redo();
  } else if (event.key === "Escape" && lineStartPoint) {
    event.preventDefault();
    cancelLine();
  } else if (event.key === "Escape" && arcStartPoint) {
    event.preventDefault();
    cancelArc();
  } else if (event.key === "Escape" && penShape) {
    event.preventDefault();
    cancelPenPath();
  } else if (event.key === "Enter" && penShape) {
    event.preventDefault();
    finishPenPath();
  } else if (!isEditingInput && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    deleteSelected();
  }
});

window.addEventListener("pagehide", () => {
  saveDrawingLocally();
});

window.addEventListener("beforeunload", (event) => {
  saveDrawingLocally();
  if (!drawingLayer.children.length) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
});

sidesInput.addEventListener("change", () => {
  sidesInput.value = clamp(Number.parseInt(sidesInput.value, 10) || 5, 3, 12);
});
textValueInput.addEventListener("change", updateSelectedText);
textValueInput.addEventListener("input", updateFontOptionPreviews);
textSizeInput.addEventListener("change", updateSelectedText);
textFontInput.addEventListener("change", updateSelectedText);

document.querySelector("#delete-button").addEventListener("click", deleteSelected);
document.querySelector("#download-button").addEventListener("click", downloadSvg);
document.querySelector("#save-button").addEventListener("click", openSaveDialog);
undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);
separatePointsButton.addEventListener("click", separateSelectedPenPoints);
deleteSelectedPointButton.addEventListener("click", deleteSelectedPoint);
joinPencilButton.addEventListener("click", joinSelectedPencilPaths);
saveFileNameInput.addEventListener("input", updateSaveConfirmation);
saveForm.addEventListener("submit", confirmSaveSvg);
cancelSaveButton.addEventListener("click", () => saveDialog.close());

const restoredSavedDrawing = restoreSavedDrawing();
normalizeClosedPenStorage();
textValueInput.value = "Testo";
updateFontOptionPreviews();
setActiveTool("select");
updateGuidePanel();
updateHistoryButtons();
initializeCanvasZoom();
if (restoredSavedDrawing) {
}
