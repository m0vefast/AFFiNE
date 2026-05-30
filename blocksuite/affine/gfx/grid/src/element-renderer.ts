import {
  type ElementRenderer,
  ElementRendererExtension,
} from '@blocksuite/affine-block-surface';
import { ColorScheme, type GridElementModel } from '@blocksuite/affine-model';

const ACCENT = 'rgba(30, 130, 250,';

// ── Theme-aware chrome color palette ───────────────────────────
// All non-model UI elements (handles, buttons, empty-cell hints, shadows)
// adapt to the current dark/light scheme.
function getChromeColors(scheme: ColorScheme) {
  const dark = scheme === ColorScheme.Dark;
  return {
    // Grab handle dots
    handleDot:        dark ? 'rgba(160,160,160,0.50)' : 'rgba(140,140,140,0.40)',
    // "+" button — default (not hovered)
    btnFill:          dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    btnStroke:        dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
    btnIcon:          dark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.28)',
    // "+" button — secondary (row above/below, col left/right)
    btnFillSec:       dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
    btnStrokeSec:     dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.12)',
    btnIconSec:       dark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.28)',
    // Empty cell dashed border
    emptyCellDash:    dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)',
    // Drag shadow
    dragShadow:       dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.20)',
    // Drag fallback fill (when model fill is transparent)
    dragFallback:     dark ? '#2a2a2a' : '#ffffff',
    // Cell resize handle circle fill
    resizeHandleFill: dark ? '#2a2a2a' : '#ffffff',
    // In-grid sub-selection accent (orange) — distinct from framework's
    // whole-grid selection rect (blue ACCENT). Template — concatenate alpha.
    selRgba:          dark ? 'rgba(255, 159, 10,' : 'rgba(255, 149, 0,',
    // Merge blocker indicator (cells containing children that would be
    // hidden under a merge rect). Template — concatenate alpha.
    blockRgba:        dark ? 'rgba(255, 69, 58,'  : 'rgba(255, 59, 48,',
  };
}

// ── Helper: draw a "+" button (circle + plus icon) ─────────────
function drawPlusButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  iconR: number,
  hovered: boolean,
  chrome: ReturnType<typeof getChromeColors>
) {
  // Circle
  ctx.fillStyle   = hovered ? `${ACCENT} 0.12)` : chrome.btnFill;
  ctx.strokeStyle  = hovered ? `${ACCENT} 0.45)` : chrome.btnStroke;
  ctx.lineWidth    = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // "+" icon
  ctx.strokeStyle  = hovered ? `${ACCENT} 0.70)` : chrome.btnIcon;
  ctx.lineWidth    = 1.8;
  ctx.beginPath();
  ctx.moveTo(x - iconR, y);
  ctx.lineTo(x + iconR, y);
  ctx.moveTo(x, y - iconR);
  ctx.lineTo(x, y + iconR);
  ctx.stroke();
}

// ── Helper: draw a secondary "+" button (smaller, for row/col insert) ──
function drawSecPlusButton(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  hovered: boolean,
  chrome: ReturnType<typeof getChromeColors>
) {
  ctx.fillStyle   = hovered ? `${ACCENT} 0.14)` : chrome.btnFillSec;
  ctx.strokeStyle  = hovered ? `${ACCENT} 0.55)` : chrome.btnStrokeSec;
  ctx.lineWidth    = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const iconR = r * 0.45;
  ctx.strokeStyle  = hovered ? `${ACCENT} 0.80)` : chrome.btnIconSec;
  ctx.lineWidth    = 1.5;
  ctx.beginPath();
  ctx.moveTo(x - iconR, y);
  ctx.lineTo(x + iconR, y);
  ctx.moveTo(x, y - iconR);
  ctx.lineTo(x, y + iconR);
  ctx.stroke();
}

export const grid: ElementRenderer<GridElementModel> = (
  model,
  ctx,
  _matrix,
  renderer,
  _rc,
  bound
) => {
  const scheme = renderer.getColorScheme();
  const chrome = getChromeColors(scheme);

  // Resolve theme-aware model colors
  const fillColor = renderer.getColorValue(
    model.fillColor,
    { light: '#FFFFFF', dark: '#252525' },
    true
  );
  const strokeColor = renderer.getColorValue(
    model.strokeColor,
    { light: '#E0E0E0', dark: '#414141' },
    true
  );
  const isFillTransparent =
    fillColor === 'transparent' || fillColor.endsWith('transparent');

  const [originX, originY] = model.deserializedXYWH;
  const dx = originX - bound.x;
  const dy = originY - bound.y;

  ctx.save();
  ctx.globalAlpha *= model.opacity;

  const totalW = model.totalWidth;
  const totalH = model.totalHeight;

  // ── Cell backgrounds + highlights ─────────────────────
  const isDraggingRow = model.draggingRow >= 0;
  const isDraggingCol = model.draggingCol >= 0;

  for (let r = 0; r < model.rows; r++) {
    for (let c = 0; c < model.cols; c++) {
      // Skip cells consumed by another cell's merge; the origin cell handles
      // drawing the whole merged region below via getMergeBound.
      if (model.isOccluded(r, c)) continue;

      // For merge origins, cb is the merged region's full bound.
      const cb = model.getMergeBound(r, c);
      let cx = cb.x - bound.x;
      let cy = cb.y - bound.y;

      // Offset dragged row/col to follow mouse
      const isThisDraggedRow = isDraggingRow && r === model.draggingRow;
      const isThisDraggedCol = isDraggingCol && c === model.draggingCol;
      if (isThisDraggedRow) cy += model.dragOffset;
      if (isThisDraggedCol) cx += model.dragOffset;

      // Resolve per-cell bgColor (overrides grid-level fillColor when set)
      const cellBg = model.getCellBgColor(r, c);
      const cellFill = cellBg
        ? renderer.getColorValue(cellBg, model.fillColor, true)
        : fillColor;
      const isCellFillTransparent =
        cellFill === 'transparent' || cellFill.endsWith('transparent');

      // Dragged row/col: shadow under offset cells
      if (isThisDraggedRow || isThisDraggedCol) {
        ctx.save();
        ctx.shadowColor = chrome.dragShadow;
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 3;
        ctx.fillStyle = !isCellFillTransparent ? cellFill : chrome.dragFallback;
        ctx.fillRect(cx, cy, cb.w, cb.h);
        ctx.restore();
      }

      // Base fill
      if (!isCellFillTransparent) {
        ctx.fillStyle = cellFill;
        ctx.fillRect(cx, cy, cb.w, cb.h);
      }

      // Cell selection: orange BORDER ONLY. Filling with translucent orange
      // tints the user's chosen cell bgColor and makes it unreadable as a
      // color preview — selection must not change the apparent fill.
      const isCellSelected = model.selectedCells.has(`${r},${c}`);

      if (isCellSelected) {
        ctx.strokeStyle = `${chrome.selRgba} 0.95)`;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(cx + 1, cy + 1, cb.w - 2, cb.h - 2);
      }

      // Hovered cell (dashed border, lighter, skip if selected)
      const hc = model.hoveredCell;
      const isCellHovered = hc && hc.row === r && hc.col === c;
      if (isCellHovered && !isCellSelected) {
        ctx.fillStyle = `${ACCENT} 0.04)`;
        ctx.fillRect(cx, cy, cb.w, cb.h);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = `${ACCENT} 0.35)`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cb.w - 1, cb.h - 1);
        ctx.setLineDash([]);
      }

      // Empty cells: subtle dashed border to indicate they accept content
      if (!model.getChildInCell(r, c) && !isCellSelected && !isCellHovered) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = chrome.emptyCellDash;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 4, cy + 4, cb.w - 8, cb.h - 8);
        ctx.setLineDash([]);
      }
    }
  }

  // ── Merge-blocker overlay (red) ───────────────────────
  // Drawn AFTER cell selection so it sits on top — the user hovering the
  // disabled Merge toolbar button populates blockedMergeCells, the canvas
  // re-renders, and these red rects pop out indicating which cells need
  // to be cleared before the merge can proceed.
  if (model.blockedMergeCells.size > 0) {
    for (const key of model.blockedMergeCells) {
      const i = key.indexOf(',');
      if (i < 0) continue;
      const br = Number(key.slice(0, i));
      const bc = Number(key.slice(i + 1));
      if (!Number.isInteger(br) || !Number.isInteger(bc)) continue;
      if (model.isOccluded(br, bc)) continue;
      const bb = model.getMergeBound(br, bc);
      const bx = bb.x - bound.x;
      const by = bb.y - bound.y;
      ctx.fillStyle = `${chrome.blockRgba} 0.14)`;
      ctx.fillRect(bx, by, bb.w, bb.h);
      ctx.strokeStyle = `${chrome.blockRgba} 0.90)`;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(bx + 1, by + 1, bb.w - 2, bb.h - 2);
    }
  }

  // ── Grid lines ────────────────────────────────────────
  ctx.strokeStyle = strokeColor;

  // Outer border (thicker)
  ctx.lineWidth = model.strokeWidth * 2;
  ctx.strokeRect(dx, dy, totalW, totalH);

  // Inner dividers — skip segments internal to a merged region.
  ctx.lineWidth = model.strokeWidth;

  const ecw = model.effectiveColWidths;
  const erh = model.effectiveRowHeights;

  // Vertical inner lines at each col boundary.
  let xv = 0;
  for (let c = 0; c < model.cols - 1; c++) {
    xv += ecw[c];
    const lineX = dx + xv + c * model.gap + model.gap / 2;
    let segY = dy;
    for (let r = 0; r < model.rows; r++) {
      const rh = erh[r];
      const o1 = model.getMergeOrigin(r, c);
      const o2 = model.getMergeOrigin(r, c + 1);
      const crossed = o1.row === o2.row && o1.col === o2.col;
      if (!crossed) {
        const segTop = r === 0 ? segY : segY - model.gap / 2;
        const segBot =
          r === model.rows - 1 ? segY + rh : segY + rh + model.gap / 2;
        ctx.beginPath();
        ctx.moveTo(lineX, segTop);
        ctx.lineTo(lineX, segBot);
        ctx.stroke();
      }
      segY += rh + model.gap;
    }
  }

  // Horizontal inner lines at each row boundary.
  let yh = 0;
  for (let r = 0; r < model.rows - 1; r++) {
    yh += erh[r];
    const lineY = dy + yh + r * model.gap + model.gap / 2;
    let segX = dx;
    for (let c = 0; c < model.cols; c++) {
      const cw = ecw[c];
      const o1 = model.getMergeOrigin(r, c);
      const o2 = model.getMergeOrigin(r + 1, c);
      const crossed = o1.row === o2.row && o1.col === o2.col;
      if (!crossed) {
        const segLeft = c === 0 ? segX : segX - model.gap / 2;
        const segRight =
          c === model.cols - 1 ? segX + cw : segX + cw + model.gap / 2;
        ctx.beginPath();
        ctx.moveTo(segLeft, lineY);
        ctx.lineTo(segRight, lineY);
        ctx.stroke();
      }
      segX += cw + model.gap;
    }
  }

  // ── Hovered grid line highlight (resize feedback) ─────
  const hl = model.hoveredLine;
  if (hl) {
    ctx.strokeStyle = `${ACCENT} 0.7)`;
    ctx.lineWidth = 3;
    if (hl.axis === 'row') {
      let ly = 0;
      for (let r = 0; r <= hl.index; r++) ly += erh[r];
      const lineY = dy + ly + hl.index * model.gap + model.gap / 2;
      ctx.beginPath();
      ctx.moveTo(dx, lineY);
      ctx.lineTo(dx + totalW, lineY);
      ctx.stroke();
    } else {
      let lx = 0;
      for (let c = 0; c <= hl.index; c++) lx += ecw[c];
      const lineX = dx + lx + hl.index * model.gap + model.gap / 2;
      ctx.beginPath();
      ctx.moveTo(lineX, dy);
      ctx.lineTo(lineX, dy + totalH);
      ctx.stroke();
    }
  }

  // ── Drag reorder indicator (insertion line between rows/cols) ──
  const dri = model.dragReorderIndicator;
  if (dri) {
    ctx.strokeStyle = `${ACCENT} 0.9)`;
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.fillStyle = `${ACCENT} 0.9)`;

    if (dri.axis === 'row') {
      const clampedRow = Math.min(dri.position, model.rows - 1);
      const cb = model.getCellBound(clampedRow, 0);
      const lineY = dri.position >= model.rows
        ? cb.y - bound.y + cb.h + model.gap / 2
        : cb.y - bound.y - model.gap / 2;

      ctx.beginPath();
      ctx.moveTo(dx - 4, lineY);
      ctx.lineTo(dx + totalW + 4, lineY);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(dx - 4, lineY, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(dx + totalW + 4, lineY, 4, 0, Math.PI * 2); ctx.fill();
    } else {
      const clampedCol = Math.min(dri.position, model.cols - 1);
      const cb = model.getCellBound(0, clampedCol);
      const lineX = dri.position >= model.cols
        ? cb.x - bound.x + cb.w + model.gap / 2
        : cb.x - bound.x - model.gap / 2;

      ctx.beginPath();
      ctx.moveTo(lineX, dy - 4);
      ctx.lineTo(lineX, dy + totalH + 4);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(lineX, dy - 4, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(lineX, dy + totalH + 4, 4, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ── Row/Col grab handles (zoom-compensated) ────────────
  // Canvas ctx is scaled by zoom, so model-px * zoom = screen-px.
  // To keep handles at a constant screen size, divide by zoom.
  // Clamp to 1.75× max — handles must stay within STACKING_CANVAS_PADDING (32px).
  // Handle max extent = (14 + 4) * s = 18 * 1.75 = 31.5 ≤ 32.
  const zoom = renderer.viewport.zoom;
  const zoomScale = Math.min(1.75, Math.max(1, 1 / zoom));
  const HANDLE_W = 14 * zoomScale;
  const HANDLE_H = 16 * zoomScale;
  const HANDLE_DOT_R = 1.5 * zoomScale;
  const HANDLE_GAP = 4 * zoomScale;
  const HANDLE_DOT_SPACING_X = 6 * zoomScale;
  const HANDLE_DOT_SPACING_Y = 4 * zoomScale;
  const HANDLE_DOT_PAD = 4 * zoomScale;
  const HANDLE_ROUND = 3 * zoomScale;

  // Row handles (left of grid)
  for (let r = 0; r < model.rows; r++) {
    const cb = model.getCellBound(r, 0);
    const hx = cb.x - bound.x - HANDLE_W - HANDLE_GAP;
    const hy = cb.y - bound.y + cb.h / 2 - HANDLE_H / 2;
    const isHovered = model.hoveredRowHandle === r;
    const isSelected =
      model.selectionMode === 'row' && model.selectedRow === r;

    if (isHovered || isSelected) {
      ctx.fillStyle = isSelected ? `${chrome.selRgba} 0.18)` : `${ACCENT} 0.08)`;
      ctx.beginPath();
      ctx.roundRect(hx, hy, HANDLE_W, HANDLE_H, HANDLE_ROUND);
      ctx.fill();
    }

    ctx.fillStyle = isSelected
      ? `${chrome.selRgba} 0.85)`
      : isHovered
        ? `${ACCENT} 0.5)`
        : chrome.handleDot;
    for (let dr = 0; dr < 3; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        ctx.beginPath();
        ctx.arc(hx + HANDLE_DOT_PAD + dc * HANDLE_DOT_SPACING_X, hy + HANDLE_DOT_PAD + dr * HANDLE_DOT_SPACING_Y, HANDLE_DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Column handles (above grid)
  for (let c = 0; c < model.cols; c++) {
    const cb = model.getCellBound(0, c);
    const hx = cb.x - bound.x + cb.w / 2 - HANDLE_H / 2;
    const hy = cb.y - bound.y - HANDLE_W - HANDLE_GAP;
    const isHovered = model.hoveredColHandle === c;
    const isSelected =
      model.selectionMode === 'col' && model.selectedCol === c;

    if (isHovered || isSelected) {
      ctx.fillStyle = isSelected ? `${chrome.selRgba} 0.18)` : `${ACCENT} 0.08)`;
      ctx.beginPath();
      ctx.roundRect(hx, hy, HANDLE_H, HANDLE_W, HANDLE_ROUND);
      ctx.fill();
    }

    ctx.fillStyle = isSelected
      ? `${chrome.selRgba} 0.85)`
      : isHovered
        ? `${ACCENT} 0.5)`
        : chrome.handleDot;
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 3; dc++) {
        ctx.beginPath();
        ctx.arc(hx + HANDLE_DOT_PAD + dc * HANDLE_DOT_SPACING_Y, hy + HANDLE_DOT_PAD + dr * HANDLE_DOT_SPACING_X, HANDLE_DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ── "+" buttons (nominal size — NOT zoom-compensated) ──
  // These extend far from grid edge (center at 18px, radius 12, max extent 30px).
  // Zoom compensation would push them beyond STACKING_CANVAS_PADDING (32px), causing clipping.
  const PLUS_R = 12;
  const PLUS_ICON = 5;
  const PLUS_GAP = 6;

  // Add Column button (right edge center)
  drawPlusButton(ctx,
    dx + totalW + PLUS_R + PLUS_GAP, dy + totalH / 2,
    PLUS_R, PLUS_ICON,
    model.hoveredAddButton === 'addCol', chrome
  );

  // Add Row button (bottom edge center)
  drawPlusButton(ctx,
    dx + totalW / 2, dy + totalH + PLUS_R + PLUS_GAP,
    PLUS_R, PLUS_ICON,
    model.hoveredAddButton === 'addRow', chrome
  );

  // ── Row/Col selection highlight (BORDER ONLY) ──────────
  // No fill overlay — see cell selection rationale above.
  if (model.selectionMode === 'row' && model.selectedRow >= 0) {
    const firstCell = model.getCellBound(model.selectedRow, 0);
    const lastCell = model.getCellBound(model.selectedRow, model.cols - 1);
    const sy = firstCell.y - bound.y;
    const sx = firstCell.x - bound.x;
    const sw = lastCell.x + lastCell.w - firstCell.x;
    ctx.strokeStyle = `${chrome.selRgba} 0.95)`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(sx, sy, sw, firstCell.h);

    // "+" buttons: add row above / below
    const handleX = sx - HANDLE_W - HANDLE_GAP + HANDLE_W / 2;
    const aboveY = sy - PLUS_R - 3;
    const belowY = sy + firstCell.h + PLUS_R + 3;

    drawSecPlusButton(ctx, handleX, aboveY, PLUS_R - 2,
      model.hoveredAddButton === 'addRowAbove', chrome);
    drawSecPlusButton(ctx, handleX, belowY, PLUS_R - 2,
      model.hoveredAddButton === 'addRowBelow', chrome);
  }

  if (model.selectionMode === 'col' && model.selectedCol >= 0) {
    const firstCell = model.getCellBound(0, model.selectedCol);
    const lastCell = model.getCellBound(model.rows - 1, model.selectedCol);
    const sx = firstCell.x - bound.x;
    const sy = firstCell.y - bound.y;
    const sh = lastCell.y + lastCell.h - firstCell.y;
    ctx.strokeStyle = `${chrome.selRgba} 0.95)`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(sx, sy, firstCell.w, sh);

    // "+" buttons: add col left / right
    const handleY = sy - HANDLE_W - HANDLE_GAP + HANDLE_W / 2;
    const leftX = sx - PLUS_R - 3;
    const rightX = sx + firstCell.w + PLUS_R + 3;

    drawSecPlusButton(ctx, leftX, handleY, PLUS_R - 2,
      model.hoveredAddButton === 'addColLeft', chrome);
    drawSecPlusButton(ctx, rightX, handleY, PLUS_R - 2,
      model.hoveredAddButton === 'addColRight', chrome);
  }

  // ── Dragged row/col unified border (over everything) ───
  if (isDraggingRow && model.draggingRow >= 0) {
    const firstCb = model.getCellBound(model.draggingRow, 0);
    const lastCb = model.getCellBound(model.draggingRow, model.cols - 1);
    const rx = firstCb.x - bound.x;
    const ry = firstCb.y - bound.y + model.dragOffset;
    const rw = lastCb.x + lastCb.w - firstCb.x;
    const rh = firstCb.h;
    ctx.strokeStyle = `${ACCENT} 0.8)`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(rx, ry, rw, rh);
  }
  if (isDraggingCol && model.draggingCol >= 0) {
    const firstCb = model.getCellBound(0, model.draggingCol);
    const lastCb = model.getCellBound(model.rows - 1, model.draggingCol);
    const rx = firstCb.x - bound.x + model.dragOffset;
    const ry = firstCb.y - bound.y;
    const rw = firstCb.w;
    const rh = lastCb.y + lastCb.h - firstCb.y;
    ctx.strokeStyle = `${ACCENT} 0.8)`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // ── Cell resize handles (zoom-compensated, drawn LAST = highest z-index) ─
  if (model.selectionMode === 'cell' && model.selectedCell) {
    const sc = model.selectedCell;
    // Use merged bound when (sc.row, sc.col) is a merge origin — handles
    // should sit on the OUTER edge of the visible region, not at the
    // single-cell edge in the middle of a merge.
    const cb = model.getMergeBound(sc.row, sc.col);
    const cx = cb.x - bound.x;
    const cy = cb.y - bound.y;
    const HR = 5 * zoomScale;
    const OFF = 6 * zoomScale;

    ctx.fillStyle = chrome.resizeHandleFill;
    ctx.strokeStyle = `${chrome.selRgba} 0.95)`;
    ctx.lineWidth = 2 * zoomScale;

    // Right edge at 72% height -> col resize
    ctx.beginPath();
    ctx.arc(cx + cb.w + OFF, cy + cb.h * 0.72, HR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    // Bottom edge at 72% width -> row resize
    ctx.beginPath();
    ctx.arc(cx + cb.w * 0.72, cy + cb.h + OFF, HR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }

  ctx.restore();
};

export const GridElementRendererExtension = ElementRendererExtension(
  'grid',
  grid
);
