import type { GridElementModel } from '@blocksuite/affine-model';
import { Bound } from '@blocksuite/global/gfx';

const CELL_PADDING = 2;

/**
 * Position each child element in its assigned grid cell.
 * Stretch to fill cell dimensions (with padding).
 */
export function layoutGrid(model: GridElementModel): void {
  for (const [id, detail] of model.children.entries()) {
    const element = model.getChildById(id);
    if (!element) continue;

    const cellBound = model.getCellBound(detail.row, detail.col);

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
