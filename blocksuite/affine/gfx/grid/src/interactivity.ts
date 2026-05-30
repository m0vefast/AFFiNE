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

const HANDLE_W_NOM = 14;
const HANDLE_MARGIN_NOM = 4;

function handleScale(zoom: number): number {
  // Cap at 1.75× — handles must stay within STACKING_CANVAS_PADDING (32px).
  return Math.min(1.75, Math.max(1, 1 / zoom));
}

function detectRowHandle(grid: GridElementModel, mx: number, my: number, zoom: number): number {
  const s = handleScale(zoom);
  const hw = HANDLE_W_NOM * s;
  const hm = HANDLE_MARGIN_NOM * s;
  const [ox, oy] = grid.deserializedXYWH;
  if (mx < ox - hw - hm || mx > ox - hm) return -1;

  let y = oy;
  for (let r = 0; r < grid.rows; r++) {
    const h = grid.effectiveRowHeights[r];
    if (my >= y && my < y + h) return r;
    y += h + grid.gap;
  }
  return -1;
}

function detectColHandle(grid: GridElementModel, mx: number, my: number, zoom: number): number {
  const s = handleScale(zoom);
  const hw = HANDLE_W_NOM * s;
  const hm = HANDLE_MARGIN_NOM * s;
  const [ox, oy] = grid.deserializedXYWH;
  if (my < oy - hw - hm || my > oy - hm) return -1;

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
  private _pendingDrill: { grid: GridElementModel; childId: string } | null = null;
  /** clearTimeout handle for the macro-task drill set in click handler. */
  private _pendingDrillTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by pointerdown on a row/col grip, consumed by the click handler.
   *  Cleared by onUp if the grip turns into a drag (reorder), so click
   *  doesn't re-select after reorder already did. */
  private _pendingRowGripSelect: { grid: GridElementModel; row: number } | null = null;
  private _pendingColGripSelect: { grid: GridElementModel; col: number } | null = null;
  private _gripDragActive = false;
  private _dragSelectAnchor: { grid: GridElementModel; row: number; col: number } | null = null;
  private _dragSelectCleanup: (() => void) | null = null;

  /** Drop any one-shot pointerdown-set flags that haven't been consumed yet.
   *  Called from Esc, outside-click, unmounted — prevents stale drill /
   *  text-creation firing on the next unrelated click. */
  private _clearPendingActions() {
    this._pendingDrill = null;
    this._pendingTextCreation = null;
    this._pendingRowGripSelect = null;
    this._pendingColGripSelect = null;
    if (this._pendingDrillTimer != null) {
      clearTimeout(this._pendingDrillTimer);
      this._pendingDrillTimer = null;
    }
  }

  /** Tear down EVERY armed host-pointer gesture. Each `_startXxx` calls this
   *  to claim exclusive ownership of pointermove/pointerup — otherwise a
   *  stale gesture (whose pointerup was dropped by WebKit) keeps firing on
   *  the new gesture's mousemove with stale state.
   *  Does NOT reset `_gripDragActive` — that flag is set by the GRIP
   *  pointerdown BEFORE `_startRowGrip`/`_startColGrip` (which themselves
   *  call this method to claim listener ownership). Resetting here would
   *  clobber the just-set flag and let framework box-select activate
   *  concurrently with our reorder. `_gripDragActive` is reset in the
   *  specific safe sites: grip `onUp`, `unmounted`, and the window-blur
   *  safety net (which always means the in-flight gesture is abandoned). */
  private _tearDownAllGestures() {
    this._activeResizeCleanup?.();
    this._dragSelectCleanup?.();
  }

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
    // Search wider to catch handle zones outside grid bounds.
    // Handles extend up to 31.5 model-px (18 * 1.75 cap). Buttons up to 30.
    // Use 44 as generous uniform pad to cover all chrome.
    const pad = 44;
    const bound = new Bound(mx - pad, my - pad, pad * 2, pad * 2);
    const elements = this.gfx.grid.search(bound);
    for (const el of elements) {
      if (!(el instanceof GridElementModel)) continue;
      const [ox, oy] = el.deserializedXYWH;
      if (
        mx >= ox - pad &&
        mx <= ox + el.totalWidth + pad &&
        my >= oy - pad &&
        my <= oy + el.totalHeight + pad
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
        select: () => { grid.surface.store.captureSync(); grid.deleteRow(row); grid.clearSelection(); },
      })] : []),
      ...(grid.cols > 1 ? [menu.action({
        name: `Remove Column`,
        select: () => { grid.surface.store.captureSync(); grid.deleteCol(col); grid.clearSelection(); },
      })] : []),
    ];

    popFilterableSimpleMenu(target, [
      menu.group({ items }),
    ]);
  }

  // ── mounted ───────────────────────────────────────────

  /** Window-level cleanup: blur / tab-hide / page-hide. Even with the
   *  per-gesture pointercancel handlers, certain OS flows (Mission Control,
   *  virtual-desktop swipe, Cmd+Tab without returning the pointer) can
   *  leave the gesture's pointermove stream silent indefinitely. Reset all
   *  gesture state when the window/tab loses focus so the user is never
   *  stuck. */
  private _windowCleanupListeners: Array<() => void> = [];
  private _installWindowSafetyNet() {
    const onLost = () => {
      this._tearDownAllGestures();
      this._clearPendingActions();
      // Explicit reset — `_tearDownAllGestures` deliberately leaves it
      // alone (called during grip init). Window-lost path always means
      // any in-flight grip gesture is abandoned, so reset is safe here.
      this._gripDragActive = false;
      // Clear per-grid drag-preview state on every grid. Tearing down
      // listeners doesn't reset `draggingRow/Col`, `dragOffset`,
      // `dragReorderIndicator` — those live on the grid model and would
      // otherwise leave a stuck preview indicator visible after the
      // user returns to the tab.
      // Guard each write — `@local()` setter fires `_onChange` →
      // `surface.elementUpdated` regardless of value equality. Without the
      // guards, every Cmd+Tab during writing triggers `6·N` toolbar
      // rebuilds across N idle grids on the canvas.
      for (const el of this.gfx.surface?.elementModels ?? []) {
        if (!(el instanceof GridElementModel)) continue;
        if (el.draggingRow !== -1) el.draggingRow = -1;
        if (el.draggingCol !== -1) el.draggingCol = -1;
        if (el.dragOffset !== 0) el.dragOffset = 0;
        if (el.dragReorderIndicator !== null) el.dragReorderIndicator = null;
        if (el.previewRowHeights !== null) el.previewRowHeights = null;
        if (el.previewColWidths !== null) el.previewColWidths = null;
      }
    };
    window.addEventListener('blur', onLost);
    window.addEventListener('pagehide', onLost);
    const onVis = () => { if (document.hidden) onLost(); };
    document.addEventListener('visibilitychange', onVis);
    this._windowCleanupListeners.push(
      () => window.removeEventListener('blur', onLost),
      () => window.removeEventListener('pagehide', onLost),
      () => document.removeEventListener('visibilitychange', onVis)
    );
  }

  override mounted() {
    this._installWindowSafetyNet();
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

      // "+" button hover detection (nominal positions — not zoom-compensated)
      const [ox, oy] = grid.deserializedXYWH;
      const addColBtnX = ox + grid.totalWidth + 18; // PLUS_R(12) + PLUS_GAP(6)
      const addColBtnY = oy + grid.totalHeight / 2;
      const addRowBtnX = ox + grid.totalWidth / 2;
      const addRowBtnY = oy + grid.totalHeight + 18;
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
        const hs = handleScale(this.gfx.viewport.zoom);
        const hwSel = HANDLE_W_NOM * hs;
        const hmSel = HANDLE_MARGIN_NOM * hs;
        const handleX = ox - hwSel - hmSel + hwSel / 2;
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
        const hsC = handleScale(this.gfx.viewport.zoom);
        const hwC = HANDLE_W_NOM * hsC;
        const hmC = HANDLE_MARGIN_NOM * hsC;
        const handleY = oy - hwC - hmC + hwC / 2;
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
      const rowH = detectRowHandle(grid, mx, my, this.gfx.viewport.zoom);
      const colH = detectColHandle(grid, mx, my, this.gfx.viewport.zoom);
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

      // Cell resize handle cursor (handles are outside cell edge, zoom-compensated)
      if (grid.selectionMode === 'cell' && grid.selectedCell) {
        const sc = grid.selectedCell;
        // Match the renderer: handles sit on the OUTER edge of a merged
        // region, not at the single-cell edge buried inside the merge.
        const cb = grid.getMergeBound(sc.row, sc.col);
        const OFF = 6 * handleScale(this.gfx.viewport.zoom);
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
      const raw = ctx.raw as PointerEvent;
      // Only left-button pointerdown drives selection / drag / handle gestures.
      // Right-click is handled by the contextmenu listener (which preserves
      // multi-cell selection when the click lands inside it). Middle-click is
      // a no-op. Falling through here on button !== 0 would clobber a
      // multi-cell selection to a single cell and arm a stale drag-select
      // anchor before the context menu opens.
      if (raw.button !== 0) return;

      const [mx, my] = this.gfx.viewport.toModelCoord(ctx.event.x, ctx.event.y);
      const grid = this._findGridAt(mx, my);
      if (!grid) return;

      // "+" button click → add row or column (nominal positions)
      const [gox, goy] = grid.deserializedXYWH;
      const addColX = gox + grid.totalWidth + 18; // PLUS_R(12) + PLUS_GAP(6)
      const addColY = goy + grid.totalHeight / 2;
      const addRowX = gox + grid.totalWidth / 2;
      const addRowY = goy + grid.totalHeight + 18;
      const PH = Math.max(16, 20 / this.gfx.viewport.zoom);

      if (Math.abs(mx - addColX) <= PH && Math.abs(my - addColY) <= PH) {
        ctx.preventDefault();
        grid.surface.store.captureSync();
        grid.insertCol(grid.cols - 1);
        return;
      }
      if (Math.abs(mx - addRowX) <= PH && Math.abs(my - addRowY) <= PH) {
        ctx.preventDefault();
        grid.surface.store.captureSync();
        grid.insertRow(grid.rows - 1);
        return;
      }

      // Row-selection "+" buttons (add above/below)
      if (grid.selectionMode === 'row' && grid.selectedRow >= 0) {
        const selCb = grid.getCellBound(grid.selectedRow, 0);
        const rs = handleScale(this.gfx.viewport.zoom);
        const rhw = HANDLE_W_NOM * rs;
        const rhm = HANDLE_MARGIN_NOM * rs;
        const hx = gox - rhw - rhm + rhw / 2;
        const abY = selCb.y - 12 - 3;
        const blY = selCb.y + selCb.h + 12 + 3;
        if (Math.abs(mx - hx) <= PH && Math.abs(my - abY) <= PH) {
          ctx.preventDefault();
          grid.surface.store.captureSync();
          grid.insertRow(grid.selectedRow - 1);
          grid.selectRow(grid.selectedRow); // selection shifts
          return;
        }
        if (Math.abs(mx - hx) <= PH && Math.abs(my - blY) <= PH) {
          ctx.preventDefault();
          grid.surface.store.captureSync();
          grid.insertRow(grid.selectedRow);
          return;
        }
      }

      // Col-selection "+" buttons (add left/right)
      if (grid.selectionMode === 'col' && grid.selectedCol >= 0) {
        const selCb = grid.getCellBound(0, grid.selectedCol);
        const cs = handleScale(this.gfx.viewport.zoom);
        const chw = HANDLE_W_NOM * cs;
        const chm = HANDLE_MARGIN_NOM * cs;
        const hy = goy - chw - chm + chw / 2;
        const ltX = selCb.x - 12 - 3;
        const rtX = selCb.x + selCb.w + 12 + 3;
        if (Math.abs(mx - ltX) <= PH && Math.abs(my - hy) <= PH) {
          ctx.preventDefault();
          grid.surface.store.captureSync();
          grid.insertCol(grid.selectedCol - 1);
          grid.selectCol(grid.selectedCol);
          return;
        }
        if (Math.abs(mx - rtX) <= PH && Math.abs(my - hy) <= PH) {
          ctx.preventDefault();
          grid.surface.store.captureSync();
          grid.insertCol(grid.selectedCol);
          return;
        }
      }

      // Row handle → click=select, drag=reorder (3px threshold)
      const rowH = detectRowHandle(grid, mx, my, this.gfx.viewport.zoom);
      if (rowH >= 0) {
        ctx.preventDefault();
        this._gripDragActive = true; // block framework box selection immediately
        if (!this._isGridActive(grid)) {
          this.gfx.selection.set({ elements: [grid.id], editing: false });
        }
        // Stash for the click handler. Grip click points land OUTSIDE the
        // grid's element bound, so the framework's click → empty-canvas →
        // selection.clear() runs after pointerup and would wipe any
        // selection we set here. The click handler defers via setTimeout(0)
        // (same trick as _pendingDrill) so our selectRow + framework
        // selection assertion runs AFTER the framework's clear.
        this._pendingRowGripSelect = { grid, row: rowH };
        this._startRowGrip(grid, rowH, raw);
        return;
      }

      // Column handle → click=select, drag=reorder (3px threshold)
      const colH = detectColHandle(grid, mx, my, this.gfx.viewport.zoom);
      if (colH >= 0) {
        ctx.preventDefault();
        this._gripDragActive = true;
        if (!this._isGridActive(grid)) {
          this.gfx.selection.set({ elements: [grid.id], editing: false });
        }
        this._pendingColGripSelect = { grid, col: colH };
        this._startColGrip(grid, colH, raw);
        return;
      }

      // If grid is NOT selected, let framework handle (1st click → select grid)
      if (!this._isGridActive(grid)) return;

      // Cell resize handle detection (handles are OUTSIDE cell edge, zoom-compensated)
      if (grid.selectionMode === 'cell' && grid.selectedCell) {
        const sc = grid.selectedCell;
        // Use merged bound when selected cell is a merge origin. Resize
        // targets the LAST row/col of the merge (the visible right/bottom
        // edge that the user sees + grabs).
        const cb = grid.getMergeBound(sc.row, sc.col);
        const span = grid.getCellSpan(sc.row, sc.col);
        const resizeCol = sc.col + (span ? span.colSpan - 1 : 0);
        const resizeRow = sc.row + (span ? span.rowSpan - 1 : 0);
        const OFF = 6 * handleScale(this.gfx.viewport.zoom);
        const HIT = Math.max(12, 16 / this.gfx.viewport.zoom);

        const rightX = cb.x + cb.w + OFF;
        const rightY = cb.y + cb.h * 0.72;
        const bottomX = cb.x + cb.w * 0.72;
        const bottomY = cb.y + cb.h + OFF;
        const cornerX = cb.x + cb.w + OFF;
        const cornerY = cb.y + cb.h + OFF;

        if (Math.abs(mx - cornerX) <= HIT && Math.abs(my - cornerY) <= HIT) {
          ctx.preventDefault();
          this._startLineResize(grid, { axis: 'col', index: resizeCol }, raw);
          return;
        }
        if (Math.abs(mx - rightX) <= HIT && Math.abs(my - rightY) <= HIT * 1.5) {
          ctx.preventDefault();
          this._startLineResize(grid, { axis: 'col', index: resizeCol }, raw);
          return;
        }
        if (Math.abs(mx - bottomX) <= HIT * 1.5 && Math.abs(my - bottomY) <= HIT) {
          ctx.preventDefault();
          this._startLineResize(grid, { axis: 'row', index: resizeRow }, raw);
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

      // Shift+click extends to a rectangular range from the anchor. Cmd/ctrl
      // are intentionally NOT a multi-select gesture in grid — disjoint cell
      // selection is not supported. Cmd-click falls through to the plain
      // single-cell select branch below; framework default is still skipped
      // in handleSelection (otherwise framework would toggle the grid out
      // of selection and hide the toolbar).
      const shift = raw.shiftKey;
      if (shift) {
        ctx.preventDefault();
        // Tear down any drag-select armed by a prior plain-click that hasn't
        // received pointerup yet — its stale anchor would otherwise clobber
        // the shift range on the next pointermove.
        this._dragSelectCleanup?.();
        this._enterGrid(grid);
        const anchor = grid.selectionAnchor ?? cell;
        grid.selectCellRange(
          anchor.row,
          anchor.col,
          cell.row,
          cell.col,
          { anchor }
        );
        this.gfx.selection.set({ elements: [grid.id], editing: false });
        this._dragSelectAnchor = null;
        return;
      }

      // STICKY: clicking inside a single-cell selection on the same cell
      // does NOT deselect. If cell has content → drill (Layer 2 → Layer 3);
      // if empty → flag text creation. Both deferred to the `click` handler
      // (post-pointerup) — performing them while pointer is still down lets
      // the framework treat the new selection as a drag-start on the
      // newly-drilled child, causing the element to follow the cursor with
      // no way to drop.
      const cellKey = `${cell.row},${cell.col}`;
      if (grid.selectedCells.size === 1 && grid.selectedCells.has(cellKey)) {
        const childId = grid.getChildInCell(cell.row, cell.col);
        ctx.preventDefault();
        if (childId) {
          this._pendingDrill = { grid, childId };
        } else {
          this._pendingTextCreation = { grid, row: cell.row, col: cell.col };
        }
        return;
      }

      // Click on a DIFFERENT cell → switch selection + arm drag-select.
      ctx.preventDefault();
      // Discard any pending drill/text from a previous (now-stale) STICKY
      // pointerdown that hasn't fired its click yet.
      this._clearPendingActions();
      this._enterGrid(grid);
      grid.selectCell(cell.row, cell.col);
      this._dragSelectAnchor = { grid, row: cell.row, col: cell.col };
      this._armCellDragSelect(grid, cell.row, cell.col, raw);
    });

    // 2b) Click handler — runs AFTER pointerup. Drill is further deferred
    // to a macro-task (setTimeout 0) so the entire framework click chain
    // settles first. Without this, the framework's `default` selection
    // handler (invoked synchronously during click on the grid) sets up a
    // drag tracker that re-targets onto whatever we set as the new
    // selection a moment later — the freshly-drilled child then becomes
    // a drag target tied to the user's current pointer position, and
    // moving the mouse makes it follow until next click.
    this.event.on('click', () => {
      if (this._pendingDrill) {
        const { grid, childId } = this._pendingDrill;
        this._pendingDrill = null;
        // Re-check + clear any prior pending drill timer.
        if (this._pendingDrillTimer != null) {
          clearTimeout(this._pendingDrillTimer);
        }
        this._pendingDrillTimer = setTimeout(() => {
          this._pendingDrillTimer = null;
          // Validate state — grid or child may have been deleted in the
          // 0-tick window (Esc, peer-Yjs delete, structural op, etc.).
          if (!grid.children.has(childId)) return;
          if (
            !this.gfx.getElementById(grid.id) &&
            !this.std.store.hasBlock(grid.id)
          ) {
            return;
          }
          grid.clearSelection();
          this.gfx.selection.set({ elements: [childId], editing: false });
        }, 0);
        return;
      }
      if (this._pendingTextCreation) {
        const { grid, row, col } = this._pendingTextCreation;
        this._pendingTextCreation = null;
        this._createTextInCell(grid, row, col);
        return;
      }
      // Row / column grip click: framework's `DefaultTool.click()` already
      // ran `selection.clear()` (default-tool.ts:215) BEFORE dispatching
      // 'click' to extensions (us). So we run AFTER the clear — just
      // re-assert synchronously. (Use setTimeout(0) as well as a safety
      // net for any post-dispatch teardown the framework may schedule.)
      if (this._pendingRowGripSelect) {
        const { grid, row } = this._pendingRowGripSelect;
        this._pendingRowGripSelect = null;
        const reassert = () => {
          if (
            !this.gfx.getElementById(grid.id) &&
            !this.std.store.hasBlock(grid.id)
          ) {
            return;
          }
          if (row >= grid.rows) return;
          this.gfx.selection.set({ elements: [grid.id], editing: false });
          grid.selectRow(row);
        };
        reassert();
        setTimeout(reassert, 0);
        return;
      }
      if (this._pendingColGripSelect) {
        const { grid, col } = this._pendingColGripSelect;
        this._pendingColGripSelect = null;
        const reassert = () => {
          if (
            !this.gfx.getElementById(grid.id) &&
            !this.std.store.hasBlock(grid.id)
          ) {
            return;
          }
          if (col >= grid.cols) return;
          this.gfx.selection.set({ elements: [grid.id], editing: false });
          grid.selectCol(col);
        };
        reassert();
        setTimeout(reassert, 0);
      }
    });

    // 2c) Prevent framework drag during ANY of our in-flight gestures.
    // Framework's `DefaultTool.dragStart` (default-tool.ts:285) starts a
    // `ContentMoving` drag (translating the grid) when click is inside a
    // selected element AND no extension preventDefaults. Without this
    // block:
    //  - grip drag: framework drag-select rect overlays our row reorder
    //  - cell drag-select: framework translates the whole grid while user
    //    drags to extend cell range
    this.event.on('dragstart', ctx => {
      if (this._gripDragActive || this._dragSelectAnchor) {
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
      // Preserve existing multi-cell selection if user right-clicked INSIDE
      // it (Numbers / Excel behavior — menu acts on the selection). Replace
      // selection with the clicked cell only when right-clicking OUTSIDE the
      // current selection.
      const cellKey = `${cell.row},${cell.col}`;
      if (!grid.selectedCells.has(cellKey)) {
        grid.selectCell(cell.row, cell.col);
      }
      this._showContextMenu(grid, cell, e.clientX, e.clientY);
    };
    host.addEventListener('contextmenu', onContextMenu);
    this._contextMenuCleanup = () =>
      host.removeEventListener('contextmenu', onContextMenu);

    // 4) Keyboard navigation
    const onKeyDown = (e: KeyboardEvent) => {
      // ── Esc layer walk (handle BEFORE the active-sub-selection early-return,
      // since Layer 3 / Layer 1 don't have selectionMode !== 'none') ──
      // L3 (framework=[child of grid])  → L2 (framework=[grid], cell=that child's home)
      // L2 (model has cell selection)   → L1 (framework=[grid], no cells)
      // L1 (framework=[grid only])      → L0 (framework=[])
      if (e.key === 'Escape') {
        // Don't fight an in-progress grip drag — its onUp will re-pin
        // framework selection to [grid] right after pointerup, clobbering
        // any clear we'd do here.
        if (this._gripDragActive) return;

        // Any unconsumed pointerdown flags become stale after Esc.
        this._clearPendingActions();
        // Also tear down any in-flight drag-select: otherwise its onMove
        // listener stays armed and rebuilds the selection we're about to
        // clear on the next pointermove, defeating Esc.
        this._tearDownAllGestures();

        const fwSel = this.gfx.selection.selectedElements;
        // L3 parent search must walk ALL grids on the surface (not just
        // viewport) — the drilled child's grid may be scrolled out of view
        // and we'd otherwise lose the L3→L2 transition entirely.
        const allGrids = (this.gfx.surface?.elementModels ?? []).filter(
          (el): el is GridElementModel => el instanceof GridElementModel
        );

        // L3: framework has exactly one element that is a child of some grid
        if (fwSel.length === 1) {
          const fw = fwSel[0];
          const parentGrid = allGrids.find(g => g.children.has(fw.id));
          if (parentGrid) {
            const detail = parentGrid.children.get(fw.id);
            if (detail) parentGrid.selectCell(detail.row, detail.col);
            this.gfx.selection.set({
              elements: [parentGrid.id],
              editing: false,
            });
            e.preventDefault();
            return;
          }
        }

        // L2: some grid has cell selection
        const gridWithCells = allGrids.find(g => g.selectionMode !== 'none');
        if (gridWithCells) {
          gridWithCells.clearSelection();
          e.preventDefault();
          return;
        }

        // L1: framework has exactly one grid selected
        if (fwSel.length === 1 && fwSel[0] instanceof GridElementModel) {
          this.gfx.selection.set({ elements: [] });
          e.preventDefault();
          return;
        }

        // No grid context — let other handlers / framework handle Esc.
        return;
      }

      // Below: keyboard nav requires an active sub-selection (Layer 2 only).
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

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Bail if the user is actually typing somewhere — an active text
        // input, textarea, or contenteditable should consume Delete /
        // Backspace as character deletion. Without this guard we'd nuke
        // the cell's child element while user is editing unrelated text.
        const tgt = (e.target as HTMLElement | null) ?? document.activeElement;
        if (
          tgt &&
          (tgt.tagName === 'INPUT' ||
            tgt.tagName === 'TEXTAREA' ||
            (tgt as HTMLElement).isContentEditable ||
            !!(tgt as HTMLElement).closest?.(
              '[contenteditable="true"], input, textarea'
            ))
        ) {
          return; // let the focused editor handle it
        }
        if (g.selectionMode === 'cell' && cell) {
          const childId = g.getChildInCell(cell.row, cell.col);
          if (childId) {
            g.surface.store.captureSync();
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
        // Derive starting cell from the BEST available signal:
        //   - selectedCell (single-cell mode)
        //   - selectionAnchor (multi/row/col mode — anchor is where the
        //     gesture started, the user's intended "cursor")
        //   - fallback (0,0) only when neither is set, which shouldn't
        //     happen given the activeGrid gate above.
        const start = cell ?? g.selectionAnchor;
        let r = start?.row ?? 0;
        let c = start?.col ?? 0;

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

              grid.surface.store.captureSync();
              grid.surface.store.transact(() => {
                for (const el of dragged) {
                  // Liveness check — peer Yjs delete during the drag (or
                  // local undo) can drop the element from the surface
                  // before drop. Calling addChildToCell with a dead id
                  // would orphan the `children` Y.Map entry: stuck cell
                  // with no resolvable element, no UI to recover.
                  if (
                    !grid.surface.getElementById(el.id) &&
                    !grid.surface.store.hasBlock(el.id)
                  ) {
                    continue;
                  }
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
        // Pointerdown outside any grid invalidates any pending click action
        // (drill / text creation) that was armed by a previous pointerdown
        // on a cell — otherwise the next stray click anywhere would fire it.
        this._clearPendingActions();
        // Also tear down any in-flight gesture whose pointerup was dropped
        // by WebKit — clicking elsewhere is a clear intent to abandon.
        this._tearDownAllGestures();
        // Walk ALL grids on surface (not just viewport) — offscreen grids
        // with stale selectedCells would otherwise re-show their selection
        // when scrolled back into view.
        const allGrids = this.gfx.surface?.elementModels ?? [];
        for (const el of allGrids) {
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
      // Recover from a lost pointerup (WebKit can drop pointerup if user
      // releases over devtools / another window). Without this, the listener
      // stays attached and fires on every subsequent unrelated pointermove.
      if (e.buttons === 0) { onUp(); return; }
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
      if (moved) {
        // Drag-reorder consumed the pending — click won't fire (or if it
        // does, we don't want to re-select the old row index).
        this._pendingRowGripSelect = null;
        if (targetRow !== row && targetRow !== row + 1) {
          const to = targetRow > row ? targetRow - 1 : targetRow;
          grid.surface.store.captureSync();
          grid.reorderRow(row, to);
          grid.selectRow(to);
          // Drag-reorder asserts framework selection synchronously — drag
          // doesn't produce a click event the framework can clear-against.
          this.gfx.selection.set({ elements: [grid.id], editing: false });
        }
      }
      // No-drag case: pending stays set, click handler handles selection
      // via setTimeout(0).
    };

    const cleanup = () => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      this._activeResizeCleanup = null;
    };

    this._tearDownAllGestures();
    this._activeResizeCleanup = cleanup;
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    // OS gestures (trackpad pinch), window switch, pointer leaving the
    // WKWebView frame — `pointercancel` fires even when `pointerup`
    // doesn't. Without this, the buttons===0 recovery in onMove is the
    // only escape and requires the user to move the pointer back over
    // the host, which may never happen.
    host.addEventListener('pointercancel', onUp);
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
      if (e.buttons === 0) { onUp(); return; }
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
      if (moved) {
        this._pendingColGripSelect = null;
        if (targetCol !== col && targetCol !== col + 1) {
          const to = targetCol > col ? targetCol - 1 : targetCol;
          grid.surface.store.captureSync();
          grid.reorderCol(col, to);
          grid.selectCol(to);
          this.gfx.selection.set({ elements: [grid.id], editing: false });
        }
      }
      // No-drag case: pending stays set, click handler handles selection.
    };

    const cleanup = () => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      host.removeEventListener('pointercancel', onUp);
      this._activeResizeCleanup = null;
    };

    this._tearDownAllGestures();
    this._activeResizeCleanup = cleanup;
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onUp);
  }

  // ── cell drag-select: drag from one cell to another to select a range ──

  private _armCellDragSelect(
    grid: GridElementModel,
    anchorR: number,
    anchorC: number,
    startEvt: PointerEvent
  ) {
    const host = this.std.host as unknown as HTMLElement;
    const sx = startEvt.clientX;
    const sy = startEvt.clientY;
    let moved = false;
    let lastR = anchorR;
    let lastC = anchorC;

    const onMove = (e: PointerEvent) => {
      if (e.buttons === 0) { onUp(); return; }
      if (!moved && Math.abs(e.clientX - sx) < 3 && Math.abs(e.clientY - sy) < 3) return;
      moved = true;
      const [mx, my] = this.gfx.viewport.toModelCoordFromClientCoord([
        e.clientX, e.clientY,
      ]);
      const cur = grid.getCellAt(mx, my);
      // Clamp to grid bounds when dragging outside: keep the last in-grid cell
      const targetR = cur?.row ?? lastR;
      const targetC = cur?.col ?? lastC;
      if (targetR === lastR && targetC === lastC) return;
      lastR = targetR;
      lastC = targetC;
      grid.selectCellRange(anchorR, anchorC, targetR, targetC, {
        anchor: { row: anchorR, col: anchorC },
      });
    };

    const onUp = () => {
      cleanup();
    };

    const cleanup = () => {
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      this._dragSelectCleanup = null;
      // Anchor cleared here (not in onUp) so EVERY teardown path heals it:
      // window blur, Esc, outside-grid pointerdown, etc. all call
      // `_tearDownAllGestures()` → `_dragSelectCleanup()` → this cleanup.
      // Without anchor clearing here, `_dragSelectAnchor` survives those
      // paths → the dragstart handler keeps blocking framework drags
      // forever until the next cell pointerdown overwrites the anchor.
      this._dragSelectAnchor = null;
    };

    this._tearDownAllGestures();
    this._dragSelectCleanup = cleanup;
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
      if (e.buttons === 0) { onUp(); return; }
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
      grid.surface.store.captureSync();
      if (line.axis === 'row') {
        grid.resizeRow(line.index, lastSize);
      } else {
        grid.resizeCol(line.index, lastSize);
      }
      // layout is called inside resizeRow/resizeCol transact
    };

    this._tearDownAllGestures();
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
    this._tearDownAllGestures();
    this._contextMenuCleanup?.();
    this._keyboardCleanup?.();
    this._clearPendingActions();
    this._clearRenderState();
    this._resetCursor();
    // `_tearDownAllGestures` deliberately does NOT reset `_gripDragActive`
    // (see its doc-comment). Reset here at unmount as a load-bearing
    // safety guarantee.
    this._gripDragActive = false;
    // Tear down the window-level safety net.
    for (const off of this._windowCleanupListeners) off();
    this._windowCleanupListeners = [];
  }
}
