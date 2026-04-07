import {
  menu,
  popFilterableSimpleMenu,
  type PopupTarget,
} from '@blocksuite/affine-components/context-menu';
import { insertEdgelessTextCommand } from '@blocksuite/affine-gfx-text';
import { GridElementModel } from '@blocksuite/affine-model';
import { Bound } from '@blocksuite/global/gfx';
import {
  type DragExtensionInitializeContext,
  type ExtensionDragEndContext,
  type ExtensionDragMoveContext,
  type GfxModel,
  InteractivityExtension,
  isGfxGroupCompatibleModel,
} from '@blocksuite/std/gfx';

import { expandCellToFit } from './view/layout.js';

// ── helpers ──────────────────────────────────────────────

function detectGridLine(
  grid: GridElementModel,
  mx: number,
  my: number,
  tolerance: number
): { axis: 'row' | 'col'; index: number } | null {
  const [ox, oy] = grid.deserializedXYWH;

  let y = oy;
  for (let r = 0; r < grid.rows - 1; r++) {
    y += grid.rowHeights[r];
    const lineY = y + r * grid.gap + grid.gap / 2;
    if (Math.abs(my - lineY) <= tolerance) return { axis: 'row', index: r };
  }

  let x = ox;
  for (let c = 0; c < grid.cols - 1; c++) {
    x += grid.colWidths[c];
    const lineX = x + c * grid.gap + grid.gap / 2;
    if (Math.abs(mx - lineX) <= tolerance) return { axis: 'col', index: c };
  }

  return null;
}

const HANDLE_W = 14;
const HANDLE_MARGIN = 4;

function detectRowHandle(grid: GridElementModel, mx: number, my: number): number {
  const [ox, oy] = grid.deserializedXYWH;
  if (mx < ox - HANDLE_W - HANDLE_MARGIN || mx > ox - HANDLE_MARGIN) return -1;

  let y = oy;
  for (let r = 0; r < grid.rows; r++) {
    const h = grid.effectiveRowHeights[r];
    if (my >= y && my < y + h) return r;
    y += h + grid.gap;
  }
  return -1;
}

function detectColHandle(grid: GridElementModel, mx: number, my: number): number {
  const [ox, oy] = grid.deserializedXYWH;
  if (my < oy - HANDLE_W - HANDLE_MARGIN || my > oy - HANDLE_MARGIN) return -1;

  let x = ox;
  for (let c = 0; c < grid.cols; c++) {
    const w = grid.effectiveColWidths[c];
    if (mx >= x && mx < x + w) return c;
    x += w + grid.gap;
  }
  return -1;
}

// ── Extension ────────────────────────────────────────────

export class GridDragExtension extends InteractivityExtension {
  static override key = 'grid-drag';

  private _cursorTarget: HTMLElement | null = null;
  private _prevCursor = '';
  private _activeResizeCleanup: (() => void) | null = null;
  private _contextMenuCleanup: (() => void) | null = null;
  private _keyboardCleanup: (() => void) | null = null;
  private _lastHoveredGrid: GridElementModel | null = null;
  private _pendingTextCreation: { grid: GridElementModel; row: number; col: number } | null = null;
  private _gripDragActive = false;

  // ── cursor helpers ────────────────────────────────────

  private _setCursor(raw: PointerEvent, cursor: string) {
    const target = raw.target as HTMLElement | null;
    if (!target) return;
    if (this._cursorTarget !== target) {
      this._resetCursor();
      this._cursorTarget = target;
      this._prevCursor = target.style.cursor;
    }
    target.style.cursor = cursor;
  }

  private _resetCursor() {
    if (this._cursorTarget) {
      this._cursorTarget.style.cursor = this._prevCursor;
      this._cursorTarget = null;
    }
  }

  private _clearRenderState() {
    if (this._lastHoveredGrid) {
      this._lastHoveredGrid.hoveredCell = null;
      this._lastHoveredGrid.hoveredLine = null;
      this._lastHoveredGrid.hoveredRowHandle = -1;
      this._lastHoveredGrid.hoveredColHandle = -1;
      this._lastHoveredGrid.hoveredAddButton = null;
      this._lastHoveredGrid = null;
    }
  }

  // ── element lookup ────────────────────────────────────

  private _findGridAt(mx: number, my: number): GridElementModel | null {
    // Search wider to catch handle zones outside grid bounds
    const pad = 44; // covers "+" buttons outside grid edge
    const bound = new Bound(mx - pad, my - pad, pad * 2, pad * 2);
    const elements = this.gfx.grid.search(bound);
    for (const el of elements) {
      if (!(el instanceof GridElementModel)) continue;
      const [ox, oy] = el.deserializedXYWH;
      // Check if point is inside grid bounds (expanded for handles + "+" buttons)
      const PLUS_ZONE = 44; // covers "+" buttons (center at +28, radius 12, + margin)
      if (
        mx >= ox - HANDLE_W - HANDLE_MARGIN &&
        mx <= ox + el.totalWidth + PLUS_ZONE &&
        my >= oy - HANDLE_W - HANDLE_MARGIN &&
        my <= oy + el.totalHeight + PLUS_ZONE
      ) {
        return el;
      }
    }
    return null;
  }

  private _findEmptyCell(
    grid: GridElementModel,
    startRow: number,
    startCol: number
  ): { row: number; col: number } | null {
    for (let r = startRow; r < grid.rows; r++) {
      const cStart = r === startRow ? startCol : 0;
      for (let c = cStart; c < grid.cols; c++) {
        if (!grid.getChildInCell(r, c)) return { row: r, col: c };
      }
    }
    return null;
  }

  /** Check if this grid is framework-selected OR has active sub-selection */
  private _isGridActive(grid: GridElementModel): boolean {
    const sel = this.gfx.selection.selectedElements;
    const frameworkSelected = sel.length === 1 && sel[0].id === grid.id;
    return frameworkSelected || grid.selectionMode !== 'none';
  }

  /** Mark grid as "entered" — sub-selection is active, framework click handler
   *  will check this flag in onSelect to preserve editing:true */
  private _enterGrid(_grid: GridElementModel) {
    // Cell selection is set by the caller (selectCell/selectRow/selectCol).
    // The onSelect handler in GridInteraction checks selectionMode
    // and sets editing:true to hide framework resize handles.
  }

  // ── context menu ──────────────────────────────────────

  private _showContextMenu(
    grid: GridElementModel,
    cell: { row: number; col: number },
    clientX: number,
    clientY: number
  ) {
    const { row, col } = cell;
    const host = this.std.host as unknown as HTMLElement;
    const root = host.closest('body') ?? document.body;

    const target: PopupTarget = {
      targetRect: {
        getBoundingClientRect: () =>
          DOMRect.fromRect({ x: clientX, y: clientY, width: 0, height: 0 }),
      },
      root: root as HTMLElement,
      popupStart: () => () => {},
    };

    const items = [
      ...(grid.rows > 1 ? [menu.action({
        name: `Remove Row`,
        select: () => { grid.deleteRow(row); grid.clearSelection(); },
      })] : []),
      ...(grid.cols > 1 ? [menu.action({
        name: `Remove Column`,
        select: () => { grid.deleteCol(col); grid.clearSelection(); },
      })] : []),
    ];

    popFilterableSimpleMenu(target, [
      menu.group({ items }),
    ]);
  }

  // ── mounted ───────────────────────────────────────────

  override mounted() {
    // 1) Hover: grid lines + cells
    this.event.on('pointermove', ctx => {
      const [mx, my] = this.gfx.viewport.toModelCoord(ctx.event.x, ctx.event.y);
      const grid = this._findGridAt(mx, my);

      if (this._lastHoveredGrid && this._lastHoveredGrid !== grid) {
        this._lastHoveredGrid.hoveredLine = null;
        this._lastHoveredGrid.hoveredCell = null;
        this._lastHoveredGrid.hoveredRowHandle = -1;
        this._lastHoveredGrid.hoveredColHandle = -1;
        this._lastHoveredGrid.hoveredAddButton = null;
      }

      if (!grid) {
        this._clearRenderState();
        this._resetCursor();
        return;
      }

      this._lastHoveredGrid = grid;

      // "+" button hover detection
      const [ox, oy] = grid.deserializedXYWH;
      const addColBtnX = ox + grid.totalWidth + 28; // PLUS_R(12) + 16
      const addColBtnY = oy + grid.totalHeight / 2;
      const addRowBtnX = ox + grid.totalWidth / 2;
      const addRowBtnY = oy + grid.totalHeight + 28;
      const PLUS_HIT = Math.max(16, 20 / this.gfx.viewport.zoom);

      if (Math.abs(mx - addColBtnX) <= PLUS_HIT && Math.abs(my - addColBtnY) <= PLUS_HIT) {
        grid.hoveredAddButton = 'addCol';
        grid.hoveredLine = null;
        grid.hoveredCell = null;
        grid.hoveredRowHandle = -1;
        grid.hoveredColHandle = -1;
        this._setCursor(ctx.raw as PointerEvent, 'pointer');
        return;
      }
      if (Math.abs(mx - addRowBtnX) <= PLUS_HIT && Math.abs(my - addRowBtnY) <= PLUS_HIT) {
        grid.hoveredAddButton = 'addRow';
        grid.hoveredLine = null;
        grid.hoveredCell = null;
        grid.hoveredRowHandle = -1;
        grid.hoveredColHandle = -1;
        this._setCursor(ctx.raw as PointerEvent, 'pointer');
        return;
      }
      // Row-selection "+" buttons (above/below selected row)
      if (grid.selectionMode === 'row' && grid.selectedRow >= 0) {
        const selCb = grid.getCellBound(grid.selectedRow, 0);
        const handleX = ox - HANDLE_W - HANDLE_MARGIN + HANDLE_W / 2;
        const aboveY = selCb.y - 12 - 3;
        const belowY = selCb.y + selCb.h + 12 + 3;
        if (Math.abs(mx - handleX) <= PLUS_HIT && Math.abs(my - aboveY) <= PLUS_HIT) {
          grid.hoveredAddButton = 'addRowAbove';
          grid.hoveredLine = null; grid.hoveredCell = null;
          this._setCursor(ctx.raw as PointerEvent, 'pointer');
          return;
        }
        if (Math.abs(mx - handleX) <= PLUS_HIT && Math.abs(my - belowY) <= PLUS_HIT) {
          grid.hoveredAddButton = 'addRowBelow';
          grid.hoveredLine = null; grid.hoveredCell = null;
          this._setCursor(ctx.raw as PointerEvent, 'pointer');
          return;
        }
      }

      // Col-selection "+" buttons (left/right of selected col)
      if (grid.selectionMode === 'col' && grid.selectedCol >= 0) {
        const selCb = grid.getCellBound(0, grid.selectedCol);
        const handleY = oy - HANDLE_W - HANDLE_MARGIN + HANDLE_W / 2;
        const leftX = selCb.x - 12 - 3;
        const rightX = selCb.x + selCb.w + 12 + 3;
        if (Math.abs(mx - leftX) <= PLUS_HIT && Math.abs(my - handleY) <= PLUS_HIT) {
          grid.hoveredAddButton = 'addColLeft';
          grid.hoveredLine = null; grid.hoveredCell = null;
          this._setCursor(ctx.raw as PointerEvent, 'pointer');
          return;
        }
        if (Math.abs(mx - rightX) <= PLUS_HIT && Math.abs(my - handleY) <= PLUS_HIT) {
          grid.hoveredAddButton = 'addColRight';
          grid.hoveredLine = null; grid.hoveredCell = null;
          this._setCursor(ctx.raw as PointerEvent, 'pointer');
          return;
        }
      }

      grid.hoveredAddButton = null;

      // Handle hover (always visible)
      const rowH = detectRowHandle(grid, mx, my);
      const colH = detectColHandle(grid, mx, my);
      grid.hoveredRowHandle = rowH;
      grid.hoveredColHandle = colH;

      if (rowH >= 0 || colH >= 0) {
        grid.hoveredLine = null;
        grid.hoveredCell = null;
        this._setCursor(ctx.raw as PointerEvent, 'grab');
        return;
      }

      // If grid is not selected, don't show interactive hover
      if (!this._isGridActive(grid)) {
        grid.hoveredLine = null;
        grid.hoveredCell = null;
        this._resetCursor();
        return;
      }

      // Cell resize handle cursor (handles are outside cell edge)
      if (grid.selectionMode === 'cell' && grid.selectedCell) {
        const sc = grid.selectedCell;
        const cb = grid.getCellBound(sc.row, sc.col);
        const OFF = 6;
        const HIT = Math.max(12, 16 / this.gfx.viewport.zoom);

        const rightX = cb.x + cb.w + OFF;
        const rightY = cb.y + cb.h * 0.72;
        const bottomX = cb.x + cb.w * 0.72;
        const bottomY = cb.y + cb.h + OFF;
        const cornerX = cb.x + cb.w + OFF;
        const cornerY = cb.y + cb.h + OFF;

        const onCorner = Math.abs(mx - cornerX) <= HIT && Math.abs(my - cornerY) <= HIT;
        const onRight = Math.abs(mx - rightX) <= HIT && Math.abs(my - rightY) <= HIT * 1.5;
        const onBottom = Math.abs(mx - bottomX) <= HIT * 1.5 && Math.abs(my - bottomY) <= HIT;

        if (onCorner || onRight || onBottom) {
          const cursor = onCorner ? 'nwse-resize' : onRight ? 'ew-resize' : 'ns-resize';
          this._setCursor(ctx.raw as PointerEvent, cursor);
          grid.hoveredLine = null;
          grid.hoveredCell = null;
          return;
        }
      }

      // Grid line resize cursor
      const line = detectGridLine(grid, mx, my, 6 / this.gfx.viewport.zoom);
      if (line) {
        grid.hoveredLine = line;
        grid.hoveredCell = null;
        this._setCursor(
          ctx.raw as PointerEvent,
          line.axis === 'row' ? 'row-resize' : 'col-resize'
        );
      } else {
        grid.hoveredLine = null;
        grid.hoveredCell = grid.getCellAt(mx, my);
        this._resetCursor();
      }
    });

    // 2) Click-depth selection:
    //    1st click: framework handles it → select grid (we do nothing)
    //    2nd click (grid already selected): select cell
    //    3rd click (cell already selected with element): select element
    this.event.on('pointerdown', ctx => {
      const [mx, my] = this.gfx.viewport.toModelCoord(ctx.event.x, ctx.event.y);
      const grid = this._findGridAt(mx, my);
      if (!grid) return;

      const raw = ctx.raw as PointerEvent;

      // "+" button click → add row or column
      const [gox, goy] = grid.deserializedXYWH;
      const addColX = gox + grid.totalWidth + 28;
      const addColY = goy + grid.totalHeight / 2;
      const addRowX = gox + grid.totalWidth / 2;
      const addRowY = goy + grid.totalHeight + 28;
      const PH = Math.max(16, 20 / this.gfx.viewport.zoom);

      if (Math.abs(mx - addColX) <= PH && Math.abs(my - addColY) <= PH) {
        ctx.preventDefault();
        grid.insertCol(grid.cols - 1);
        return;
      }
      if (Math.abs(mx - addRowX) <= PH && Math.abs(my - addRowY) <= PH) {
        ctx.preventDefault();
        grid.insertRow(grid.rows - 1);
        return;
      }

      // Row-selection "+" buttons (add above/below)
      if (grid.selectionMode === 'row' && grid.selectedRow >= 0) {
        const selCb = grid.getCellBound(grid.selectedRow, 0);
        const hx = gox - HANDLE_W - HANDLE_MARGIN + HANDLE_W / 2;
        const abY = selCb.y - 12 - 3;
        const blY = selCb.y + selCb.h + 12 + 3;
        if (Math.abs(mx - hx) <= PH && Math.abs(my - abY) <= PH) {
          ctx.preventDefault();
          grid.insertRow(grid.selectedRow - 1);
          grid.selectRow(grid.selectedRow); // selection shifts
          return;
        }
        if (Math.abs(mx - hx) <= PH && Math.abs(my - blY) <= PH) {
          ctx.preventDefault();
          grid.insertRow(grid.selectedRow);
          return;
        }
      }

      // Col-selection "+" buttons (add left/right)
      if (grid.selectionMode === 'col' && grid.selectedCol >= 0) {
        const selCb = grid.getCellBound(0, grid.selectedCol);
        const hy = goy - HANDLE_W - HANDLE_MARGIN + HANDLE_W / 2;
        const ltX = selCb.x - 12 - 3;
        const rtX = selCb.x + selCb.w + 12 + 3;
        if (Math.abs(mx - ltX) <= PH && Math.abs(my - hy) <= PH) {
          ctx.preventDefault();
          grid.insertCol(grid.selectedCol - 1);
          grid.selectCol(grid.selectedCol);
          return;
        }
        if (Math.abs(mx - rtX) <= PH && Math.abs(my - hy) <= PH) {
          ctx.preventDefault();
          grid.insertCol(grid.selectedCol);
          return;
        }
      }

      // Row handle → click=select, drag=reorder (3px threshold)
      const rowH = detectRowHandle(grid, mx, my);
      if (rowH >= 0) {
        ctx.preventDefault();
        this._gripDragActive = true; // block framework box selection immediately
        if (!this._isGridActive(grid)) {
          this.gfx.selection.set({ elements: [grid.id], editing: false });
        }
        this._startRowGrip(grid, rowH, raw);
        return;
      }

      // Column handle → click=select, drag=reorder (3px threshold)
      const colH = detectColHandle(grid, mx, my);
      if (colH >= 0) {
        ctx.preventDefault();
        this._gripDragActive = true;
        if (!this._isGridActive(grid)) {
          this.gfx.selection.set({ elements: [grid.id], editing: false });
        }
        this._startColGrip(grid, colH, raw);
        return;
      }

      // If grid is NOT selected, let framework handle (1st click → select grid)
      if (!this._isGridActive(grid)) return;

      // Cell resize handle detection (handles are OUTSIDE cell edge)
      if (grid.selectionMode === 'cell' && grid.selectedCell) {
        const sc = grid.selectedCell;
        const cb = grid.getCellBound(sc.row, sc.col);
        const OFF = 6;
        const HIT = Math.max(12, 16 / this.gfx.viewport.zoom);

        const rightX = cb.x + cb.w + OFF;
        const rightY = cb.y + cb.h * 0.72;
        const bottomX = cb.x + cb.w * 0.72;
        const bottomY = cb.y + cb.h + OFF;
        const cornerX = cb.x + cb.w + OFF;
        const cornerY = cb.y + cb.h + OFF;

        if (Math.abs(mx - cornerX) <= HIT && Math.abs(my - cornerY) <= HIT) {
          ctx.preventDefault();
          this._startLineResize(grid, { axis: 'col', index: sc.col }, raw);
          return;
        }
        if (Math.abs(mx - rightX) <= HIT && Math.abs(my - rightY) <= HIT * 1.5) {
          ctx.preventDefault();
          this._startLineResize(grid, { axis: 'col', index: sc.col }, raw);
          return;
        }
        if (Math.abs(mx - bottomX) <= HIT * 1.5 && Math.abs(my - bottomY) <= HIT) {
          ctx.preventDefault();
          this._startLineResize(grid, { axis: 'row', index: sc.row }, raw);
          return;
        }
      }

      // Grid line resize
      const tol = 8 / this.gfx.viewport.zoom;
      const line = detectGridLine(grid, mx, my, tol);
      if (line) {
        ctx.preventDefault();
        this._startLineResize(grid, line, raw);
        return;
      }

      // Check which cell was clicked
      const cell = grid.getCellAt(mx, my);
      if (!cell) return;

      // STICKY: clicking inside the already-selected cell does NOT deselect.
      // Only drill to element on 3rd click if cell has content.
      if (
        grid.selectionMode === 'cell' &&
        grid.selectedCell?.row === cell.row &&
        grid.selectedCell?.col === cell.col
      ) {
        const childId = grid.getChildInCell(cell.row, cell.col);
        if (childId) {
          // 3rd click → drill to element
          ctx.preventDefault();
          grid.clearSelection();
          this.gfx.selection.set({ elements: [childId], editing: false });
        } else {
          // 3rd click on empty cell → flag for text creation in click handler
          ctx.preventDefault();
          this._pendingTextCreation = { grid, row: cell.row, col: cell.col };
        }
        return;
      }

      // Click on a DIFFERENT cell → switch selection
      ctx.preventDefault();
      this._enterGrid(grid);
      grid.selectCell(cell.row, cell.col);
    });

    // 2b) Click handler — runs AFTER handleElementSelection completes.
    // Used for text creation in empty cells (must happen after selection is settled).
    this.event.on('click', () => {
      if (this._pendingTextCreation) {
        const { grid, row, col } = this._pendingTextCreation;
        this._pendingTextCreation = null;
        this._createTextInCell(grid, row, col);
      }
    });

    // 2c) Prevent framework box selection during grip drag
    this.event.on('dragstart', ctx => {
      if (this._gripDragActive) {
        ctx.preventDefault();
      }
    });

    // 3) Right-click context menu
    const host = this.std.host as unknown as HTMLElement;
    const onContextMenu = (e: MouseEvent) => {
      const [mx, my] = this.gfx.viewport.toModelCoord(e.x, e.y);
      const grid = this._findGridAt(mx, my);
      if (!grid) return;
      const cell = grid.getCellAt(mx, my);
      if (!cell) return;

      e.preventDefault();
      e.stopPropagation();
      this._enterGrid(grid);
      grid.selectCell(cell.row, cell.col);
      this._showContextMenu(grid, cell, e.clientX, e.clientY);
    };
    host.addEventListener('contextmenu', onContextMenu);
    this._contextMenuCleanup = () =>
      host.removeEventListener('contextmenu', onContextMenu);

    // 4) Keyboard navigation
    const onKeyDown = (e: KeyboardEvent) => {
      // Find grid with active sub-selection
      const allElements = this.gfx.grid.search(this.gfx.viewport.viewportBounds);
      let activeGrid: GridElementModel | null = null;
      for (const el of allElements) {
        if (el instanceof GridElementModel && el.selectionMode !== 'none') {
          activeGrid = el;
          break;
        }
      }
      if (!activeGrid) return;

      const g = activeGrid;
      const cell = g.selectedCell;

      if (e.key === 'Escape') {
        g.clearSelection();
        e.preventDefault();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (g.selectionMode === 'cell' && cell) {
          const childId = g.getChildInCell(cell.row, cell.col);
          if (childId) {
            g.surface.store.transact(() => {
              g.children.delete(childId);
              if (g.surface.hasElementById(childId)) {
                g.surface.deleteElement(childId);
              } else if (g.surface.store.hasBlock(childId)) {
                g.surface.store.deleteBlock(childId);
              }
            });
          }
        }
        e.preventDefault();
        return;
      }

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) {
        let r = cell?.row ?? 0;
        let c = cell?.col ?? 0;

        switch (e.key) {
          case 'ArrowUp': r = Math.max(0, r - 1); break;
          case 'ArrowDown': r = Math.min(g.rows - 1, r + 1); break;
          case 'ArrowLeft': c = Math.max(0, c - 1); break;
          case 'ArrowRight': c = Math.min(g.cols - 1, c + 1); break;
          case 'Tab':
            if (e.shiftKey) {
              c--;
              if (c < 0) { c = g.cols - 1; r = Math.max(0, r - 1); }
            } else {
              c++;
              if (c >= g.cols) { c = 0; r = Math.min(g.rows - 1, r + 1); }
            }
            break;
        }

        g.selectCell(r, c);
        e.preventDefault();
        return;
      }

      if (e.key === 'Enter' && g.selectionMode === 'cell' && cell) {
        const childId = g.getChildInCell(cell.row, cell.col);
        if (childId) {
          g.clearSelection();
          this.gfx.selection.set({ elements: [childId], editing: false });
        } else {
          // Enter on empty cell → create edgeless-text
          queueMicrotask(() => {
            this._createTextInCell(g, cell.row, cell.col);
          });
        }
        e.preventDefault();
      }
    };
    host.addEventListener('keydown', onKeyDown);
    this._keyboardCleanup = () => host.removeEventListener('keydown', onKeyDown);

    // 5) Drag-to-cell / re-assign cell / drag out of grid
    this.action.onDragInitialize(
      (initCtx: DragExtensionInitializeContext) => {
        // Check if a grid itself is being dragged (vs individual elements)
        const gridBeingDragged = initCtx.elements.some(
          e => e instanceof GridElementModel
        );

        const dragged = initCtx.elements.filter(e => {
          if (e instanceof GridElementModel) return false;
          // If a grid is being dragged, skip its children (they move with the grid)
          if (gridBeingDragged) {
            const group = e.group;
            if (group && group instanceof GridElementModel) return false;
          }
          return true;
        });
        if (dragged.length === 0) return {};

        let targetGrid: GridElementModel | null = null;

        return {
          onDragMove: (moveCtx: ExtensionDragMoveContext) => {
            const { x, y } = moveCtx.dragLastPos;
            const grid = this._findGridAt(x, y);

            if (targetGrid && targetGrid !== grid) {
              targetGrid.hoveredCell = null;
            }

            if (grid) {
              grid.hoveredCell = grid.getCellAt(x, y);
              targetGrid = grid;
            } else {
              targetGrid = null;
            }
          },

          onDragEnd: (_endCtx: ExtensionDragEndContext) => {
            if (targetGrid && targetGrid.hoveredCell) {
              // Drop onto a grid cell (new grid, same grid different cell, or same cell)
              const grid = targetGrid;
              let { row, col } = grid.hoveredCell;

              grid.surface.store.transact(() => {
                for (const el of dragged) {
                  // Remove from any existing group/grid
                  if (isGfxGroupCompatibleModel(el.group)) {
                    (el.group as { removeChild: (e: GfxModel) => void }).removeChild(el);
                  }
                  const target = this._findEmptyCell(grid, row, col);
                  if (target) {
                    expandCellToFit(grid, target.row, target.col, el.elementBound.w, el.elementBound.h);
                    grid.addChildToCell(el, target.row, target.col);
                    col = target.col + 1;
                    if (col >= grid.cols) { col = 0; row = target.row + 1; }
                  }
                }
                grid.layout();
              });
            } else {
              // Dropped outside any grid → remove from parent grid (element becomes free)
              for (const el of dragged) {
                if (isGfxGroupCompatibleModel(el.group) && el.group instanceof GridElementModel) {
                  const parentGrid = el.group as GridElementModel;
                  parentGrid.removeChild(el);
                }
              }
            }
            if (targetGrid) {
              targetGrid.hoveredCell = null;
              targetGrid = null;
            }
          },

          clear: () => {
            if (targetGrid) { targetGrid.hoveredCell = null; targetGrid = null; }
          },
        };
      }
    );

    // 6) Clear grid sub-selection when clicking outside
    this.event.on('pointerdown', ctx => {
      const [mx, my] = this.gfx.viewport.toModelCoord(ctx.event.x, ctx.event.y);
      const grid = this._findGridAt(mx, my);
      if (!grid) {
        const allElements = this.gfx.grid.search(this.gfx.viewport.viewportBounds);
        for (const el of allElements) {
          if (el instanceof GridElementModel && el.selectionMode !== 'none') {
            el.clearSelection();
          }
        }
      }
    });
  }

  // ── create edgeless-text in empty cell ─────────────────

  private _createTextInCell(
    grid: GridElementModel,
    row: number,
    col: number
  ) {
    const cellBound = grid.getCellBound(row, col);
    const padding = 2;

    // Create edgeless-text block sized to fit the cell
    const [, result] = this.std.command.exec(insertEdgelessTextCommand, {
      x: cellBound.x + cellBound.w / 2,
      y: cellBound.y + cellBound.h / 2,
    });

    if (result?.textId) {
      const textId = result.textId;

      // Size the text block to fill the cell (compact, minimal padding)
      const textElement = this.gfx.getElementById(textId);
      if (textElement) {
        textElement.xywh = new Bound(
          cellBound.x + padding,
          cellBound.y + padding,
          cellBound.w - padding * 2,
          cellBound.h - padding * 2
        ).serialize();
      }

      // Add as grid child
      grid.addChildToCell({ id: textId } as any, row, col);
      grid.clearSelection();
    }
  }

  // ── row grip: click = select, drag = reorder (3px threshold) ──

  private _startRowGrip(
    grid: GridElementModel,
    row: number,
    startEvt: PointerEvent
  ) {
    const host = this.std.host as unknown as HTMLElement;
    const sx = startEvt.clientX;
    const sy = startEvt.clientY;
    let moved = false;
    let targetRow = row;

    const startModel = this.gfx.viewport.toModelCoordFromClientCoord([sx, sy]);

    const onMove = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - sx) < 3 && Math.abs(e.clientY - sy) < 3) return;
      if (!moved) { moved = true; grid.draggingRow = row; }
      const cur = this.gfx.viewport.toModelCoordFromClientCoord([e.clientX, e.clientY]);
      grid.dragOffset = cur[1] - startModel[1];

      // Find nearest row BOUNDARY (0..rows), not row cell
      const [, gy] = grid.deserializedXYWH;
      const rh = grid.effectiveRowHeights;
      let bestBoundary = 0;
      let bestDist = Infinity;
      let y = gy;
      for (let i = 0; i <= grid.rows; i++) {
        const d = Math.abs(cur[1] - y);
        if (d < bestDist) { bestDist = d; bestBoundary = i; }
        if (i < grid.rows) y += rh[i] + grid.gap;
      }
      targetRow = bestBoundary;
      grid.dragReorderIndicator = { axis: 'row', position: targetRow };
    };

    const onUp = () => {
      cleanup();
      grid.dragReorderIndicator = null;
      grid.draggingRow = -1;
      grid.dragOffset = 0;
      this._gripDragActive = false;
      if (!moved) {
        grid.selectRow(row);
      } else if (targetRow !== row && targetRow !== row + 1) {
        // targetRow is a boundary index: 0=before first, rows=after last
        // Convert to splice target, adjusting for removal shift
        const to = targetRow > row ? targetRow - 1 : targetRow;
        grid.reorderRow(row, to);
        grid.selectRow(to);
      }
    };

    const cleanup = () => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      this._activeResizeCleanup = null;
    };

    this._activeResizeCleanup?.();
    this._activeResizeCleanup = cleanup;
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
  }

  // ── col grip: click = select, drag = reorder (3px threshold) ──

  private _startColGrip(
    grid: GridElementModel,
    col: number,
    startEvt: PointerEvent
  ) {
    const host = this.std.host as unknown as HTMLElement;
    const sx = startEvt.clientX;
    const sy = startEvt.clientY;
    let moved = false;
    let targetCol = col;

    const startModel = this.gfx.viewport.toModelCoordFromClientCoord([sx, sy]);

    const onMove = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - sx) < 3 && Math.abs(e.clientY - sy) < 3) return;
      if (!moved) { moved = true; grid.draggingCol = col; }
      const cur = this.gfx.viewport.toModelCoordFromClientCoord([e.clientX, e.clientY]);
      grid.dragOffset = cur[0] - startModel[0];

      // Find nearest col BOUNDARY (0..cols)
      const [gx] = grid.deserializedXYWH;
      const cw = grid.effectiveColWidths;
      let bestBoundary = 0;
      let bestDist = Infinity;
      let x = gx;
      for (let i = 0; i <= grid.cols; i++) {
        const d = Math.abs(cur[0] - x);
        if (d < bestDist) { bestDist = d; bestBoundary = i; }
        if (i < grid.cols) x += cw[i] + grid.gap;
      }
      targetCol = bestBoundary;
      grid.dragReorderIndicator = { axis: 'col', position: targetCol };
    };

    const onUp = () => {
      cleanup();
      grid.dragReorderIndicator = null;
      grid.draggingCol = -1;
      grid.dragOffset = 0;
      this._gripDragActive = false;
      if (!moved) {
        grid.selectCol(col);
      } else if (targetCol !== col && targetCol !== col + 1) {
        const to = targetCol > col ? targetCol - 1 : targetCol;
        grid.reorderCol(col, to);
        grid.selectCol(to);
      }
    };

    const cleanup = () => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      this._activeResizeCleanup = null;
    };

    this._activeResizeCleanup?.();
    this._activeResizeCleanup = cleanup;
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
  }

  // ── grid-line resize ──────────────────────────────────

  private _startLineResize(
    grid: GridElementModel,
    line: { axis: 'row' | 'col'; index: number },
    startEvt: PointerEvent
  ) {
    const startModel = this.gfx.viewport.toModelCoordFromClientCoord([
      startEvt.clientX, startEvt.clientY,
    ]);
    const origSizes = line.axis === 'row' ? [...grid.rowHeights] : [...grid.colWidths];

    const host = this.std.host as unknown as HTMLElement;
    let lastSize = origSizes[line.index];

    const onMove = (e: PointerEvent) => {
      const cur = this.gfx.viewport.toModelCoordFromClientCoord([e.clientX, e.clientY]);
      const delta = line.axis === 'row' ? cur[1] - startModel[1] : cur[0] - startModel[0];
      lastSize = Math.max(20, origSizes[line.index] + delta);

      // Preview only — @local() fields, not Yjs
      if (line.axis === 'row') {
        const h = [...origSizes]; h[line.index] = lastSize;
        grid.previewRowHeights = h;
      } else {
        const w = [...origSizes]; w[line.index] = lastSize;
        grid.previewColWidths = w;
      }
      grid.layout();
    };

    const onUp = () => {
      grid.previewRowHeights = null;
      grid.previewColWidths = null;
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      this._activeResizeCleanup = null;
      grid.hoveredLine = null;
      this._resetCursor();

      // Single Yjs transaction — one undo step
      if (line.axis === 'row') {
        grid.resizeRow(line.index, lastSize);
      } else {
        grid.resizeCol(line.index, lastSize);
      }
      // layout is called inside resizeRow/resizeCol transact
    };

    this._activeResizeCleanup?.();
    this._activeResizeCleanup = () => {
      grid.previewRowHeights = null;
      grid.previewColWidths = null;
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
    };
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
  }

  override unmounted() {
    super.unmounted();
    this._activeResizeCleanup?.();
    this._contextMenuCleanup?.();
    this._keyboardCleanup?.();
    this._clearRenderState();
    this._resetCursor();
  }
}
