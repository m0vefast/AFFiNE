import type { GridElementModel } from '@blocksuite/affine-model';
import { Bound } from '@blocksuite/global/gfx';

// 6px gives a visible cell frame around content even when the child fills
// the cell — matches Numbers / Excel and makes Layer 2 cell-selection
// visually obvious without relying on user click precision.
const CELL_PADDING = 6;

/**
 * Position each child element in its assigned grid cell.
 * Stretch to fill cell dimensions (with padding).
 */
export function layoutGrid(model: GridElementModel): void {
  for (const [id, detail] of model.children.entries()) {
    const element = model.getChildById(id);
    if (!element) continue;

    // Use merged region bound when (row,col) is a merge origin; otherwise
    // falls back to the cell's own bound. Children placed in cells that
    // are occluded by another merge keep their own cell bound (visually
    // they end up under the merged region — rare in practice).
    const cellBound = model.getMergeBound(detail.row, detail.col);

    const maxW = cellBound.w - CELL_PADDING * 2;
    const maxH = cellBound.h - CELL_PADDING * 2;
    if (maxW <= 0 || maxH <= 0) continue;

    const newX = cellBound.x + CELL_PADDING;
    const newY = cellBound.y + CELL_PADDING;

    element.xywh = new Bound(newX, newY, maxW, maxH).serialize();
  }
}

/**
 * Expand cell to fit an element. Used on drop and on element size change.
 */
export function expandCellToFit(
  grid: GridElementModel,
  row: number,
  col: number,
  elementWidth: number,
  elementHeight: number
) {
  const neededW = elementWidth + CELL_PADDING * 2;
  const neededH = elementHeight + CELL_PADDING * 2;

  const currentW = grid.effectiveColWidths[col];
  const currentH = grid.effectiveRowHeights[row];

  let changed = false;
  if (neededW > currentW) {
    grid.resizeCol(col, neededW);
    changed = true;
  }
  if (neededH > currentH) {
    grid.resizeRow(row, neededH);
    changed = true;
  }
  return changed;
}
