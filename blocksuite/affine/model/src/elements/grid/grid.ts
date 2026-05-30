import type { IVec, PointLocation, SerializedXYWH } from '@blocksuite/global/gfx';
import { Bound, linePolygonIntersects } from '@blocksuite/global/gfx';
import type {
  BaseElementProps,
  GfxModel,
  GfxGroupCompatibleInterface,
  SerializedElement,
} from '@blocksuite/std/gfx';
import {
  canSafeAddToContainer,
  field,
  GfxPrimitiveElementModel,
  gfxGroupCompatibleSymbol,
  local,
  observe,
  watch,
} from '@blocksuite/std/gfx';
import type { GfxBlockElementModel } from '@blocksuite/std/gfx';
import * as Y from 'yjs';

import type { Color } from '../../themes/index.js';

export type CellDetail = {
  row: number;
  col: number;
};

export type CellStyle = {
  bgColor?: Color;
};

export type CellSpan = {
  rowSpan: number;
  colSpan: number;
};

type GridElementProps = BaseElementProps & {
  children: Y.Map<CellDetail>;
  cellStyles: Y.Map<CellStyle>;
  cellSpans: Y.Map<CellSpan>;
};

export type SerializedGridElement = SerializedElement & {
  children: Record<string, CellDetail>;
  cellStyles: Record<string, CellStyle>;
  cellSpans: Record<string, CellSpan>;
};

/** Key format for cellStyles: `${row},${col}`. */
function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

function parseCellKey(key: string): { row: number; col: number } | null {
  const i = key.indexOf(',');
  if (i < 0) return null;
  const r = Number(key.slice(0, i));
  const c = Number(key.slice(i + 1));
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
  return { row: r, col: c };
}

function observeChildren(
  _: unknown,
  instance: GridElementModel,
  transaction: Y.Transaction | null
) {
  if (instance.children.doc) {
    instance.setChildIds(
      Array.from(instance.children.keys()),
      transaction?.local ?? true
    );
  }
}

// No-op: layout is called inside each structural method's transact now.
// This watcher exists only to satisfy the @watch decorator requirement.
function watchGridStructure(
  _: unknown,
  _instance: GridElementModel,
  _local: boolean
) {
  // Intentionally empty — layout happens inside transact for undo atomicity
}

export class GridElementModel
  extends GfxPrimitiveElementModel<GridElementProps>
  implements GfxGroupCompatibleInterface
{
  [gfxGroupCompatibleSymbol] = true as const;

  private _childIds: string[] = [];

  private _layout: (() => void) | null = null;

  get type() {
    return 'grid';
  }

  /** Grid is not connectable — disables framework auto-connect "+" buttons */
  override get connectable() {
    return false;
  }

  /** Use effective (preview-aware) dimensions so the stacking canvas
   *  bounds stay in sync during resize drag — prevents content clipping. */
  override get w() {
    return this.totalWidth;
  }

  override get h() {
    return this.totalHeight;
  }

  override get rotate() {
    return 0;
  }

  override set rotate(_: number) {}

  static propsToY(props: Record<string, unknown>) {
    if (props.children && !(props.children instanceof Y.Map)) {
      const children = new Y.Map<CellDetail>();
      Object.entries(props.children as Record<string, CellDetail>).forEach(
        ([key, value]) => {
          children.set(key, value);
        }
      );
      props.children = children;
    }
    if (props.cellStyles && !(props.cellStyles instanceof Y.Map)) {
      const cellStyles = new Y.Map<CellStyle>();
      Object.entries(props.cellStyles as Record<string, CellStyle>).forEach(
        ([key, value]) => {
          cellStyles.set(key, value);
        }
      );
      props.cellStyles = cellStyles;
    }
    if (props.cellSpans && !(props.cellSpans instanceof Y.Map)) {
      const cellSpans = new Y.Map<CellSpan>();
      Object.entries(props.cellSpans as Record<string, CellSpan>).forEach(
        ([key, value]) => {
          cellSpans.set(key, value);
        }
      );
      props.cellSpans = cellSpans;
    }
    return props as GridElementProps;
  }

  // --- Yjs-backed fields ---

  @observe(observeChildren)
  @field()
  accessor children: Y.Map<CellDetail> = new Y.Map<CellDetail>();

  @watch(watchGridStructure)
  @field()
  accessor colWidths: number[] = [200, 200, 200];

  @watch(watchGridStructure)
  @field()
  accessor rowHeights: number[] = [150, 150, 150];

  /** Derived from rowHeights.length — no separate Yjs field. */
  get rows(): number {
    return this.rowHeights.length;
  }

  /** Derived from colWidths.length — no separate Yjs field. */
  get cols(): number {
    return this.colWidths.length;
  }

  @watch(watchGridStructure)
  @field()
  accessor gap: number = 4;

  @field()
  accessor strokeColor: Color = { light: '#E0E0E0', dark: '#414141' };

  @field()
  accessor strokeWidth: number = 1;

  @field()
  accessor fillColor: Color = { light: '#FFFFFF', dark: '#252525' };

  /** Per-cell style overrides. Key: `${row},${col}`. Nested Y.Map mutations
   *  (e.g. `setCellStyle`) do NOT fire `surface.elementUpdated` — the
   *  framework's `yMap.observe` is shallow. Callers that need the toolbar
   *  widget to re-render (e.g. after a color pick) must explicitly bump
   *  `styleVersion` via `bumpStyleVersion()` AT THE COMMIT POINT. We
   *  deliberately do NOT auto-bump on every Y.Map.observe event: the
   *  color picker fires `pick` 60×/sec during drag, and re-rendering the
   *  toolbar each tick re-mounts the picker and kills its drag state. */
  @field()
  accessor cellStyles: Y.Map<CellStyle> = new Y.Map<CellStyle>();

  /** Merged cell origins. Key: `${originR},${originC}`. Value: span dims.
   *  Invariant: rowSpan>=1 && colSpan>=1 && (rowSpan>1 || colSpan>1).
   *  Single 1x1 cells are NOT in this map. */
  @field()
  accessor cellSpans: Y.Map<CellSpan> = new Y.Map<CellSpan>();

  /** Bumped by callers after a logical batch of cellStyles mutations is
   *  complete (e.g. color picker `end`, merge/unmerge, structural ops).
   *  The `@local()` setter fires `_onChange` → `surface.elementUpdated`
   *  → toolbar widget re-renders, re-evaluating `getCellBgColor(...)`.
   *  Value is unused; only the assignment side-effect matters. */
  @local()
  accessor styleVersion: number = 0;

  bumpStyleVersion(): void {
    this.styleVersion = (this.styleVersion + 1) | 0;
  }

  @field()
  accessor xywh: SerializedXYWH = '[0,0,604,454]';

  // --- Transient render state (not persisted) ---

  @local()
  accessor hoveredCell: { row: number; col: number } | null = null;

  @local()
  accessor hoveredLine: { axis: 'row' | 'col'; index: number } | null = null;

  /** Transient resize preview — renderer uses these instead of Yjs fields when set. */
  @local()
  accessor previewColWidths: number[] | null = null;

  @local()
  accessor previewRowHeights: number[] | null = null;

  /** Row handle hovered (left edge grip). -1 = none. */
  @local()
  accessor hoveredRowHandle: number = -1;

  /** Col handle hovered (top edge grip). -1 = none. */
  @local()
  accessor hoveredColHandle: number = -1;

  /** Visual indicator during row/col drag-reorder. */
  @local()
  accessor dragReorderIndicator: {
    axis: 'row' | 'col';
    position: number;
  } | null = null;

  /** Row/col drag state: index + pixel offset from original position. */
  @local()
  accessor draggingRow: number = -1;

  @local()
  accessor draggingCol: number = -1;

  @local()
  accessor dragOffset: number = 0;

  /** Hovered "+" button */
  @local()
  accessor hoveredAddButton: 'addRow' | 'addCol' | 'addRowAbove' | 'addRowBelow' | 'addColLeft' | 'addColRight' | null = null;

  // --- Selection state (not persisted) ---
  //
  // Unified storage: a Set of "row,col" keys. All single/range/disjoint
  // selections live here. selectionMode / selectedCell / selectedRow /
  // selectedCol are derived getters kept for renderer + interactivity
  // backwards-compatibility — never assign them directly.

  @local()
  accessor selectedCells: Set<string> = new Set<string>();

  /** Anchor cell for shift-click range extension. -1 col = no anchor. */
  @local()
  accessor selectionAnchor: { row: number; col: number } | null = null;

  /** Transient indicator — when non-empty, the renderer overlays a red
   *  "blocked" border on each cell. Set by the toolbar's Merge button on
   *  mouseenter to point out which cells contain content that would be
   *  hidden under the merge; cleared on mouseleave. */
  @local()
  accessor blockedMergeCells: Set<string> = new Set<string>();

  clearSelection() {
    this.selectedCells = new Set();
    this.selectionAnchor = null;
  }

  /** Replace selection with one cell; also sets it as the shift anchor. */
  selectCell(row: number, col: number) {
    this.selectedCells = new Set([cellKey(row, col)]);
    this.selectionAnchor = { row, col };
  }

  /** Replace with all cells in the rectangle (inclusive, any corner order). */
  selectCellRange(
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    options: { anchor?: { row: number; col: number } } = {}
  ) {
    const minR = Math.min(r1, r2);
    const maxR = Math.max(r1, r2);
    const minC = Math.min(c1, c2);
    const maxC = Math.max(c1, c2);
    const next = new Set<string>();
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) next.add(cellKey(r, c));
    }
    this.selectedCells = next;
    this.selectionAnchor = options.anchor ?? { row: r1, col: c1 };
  }

  selectRow(row: number) {
    if (row < 0 || row >= this.rows) return;
    const next = new Set<string>();
    for (let c = 0; c < this.cols; c++) next.add(cellKey(row, c));
    this.selectedCells = next;
    this.selectionAnchor = { row, col: 0 };
  }

  selectCol(col: number) {
    if (col < 0 || col >= this.cols) return;
    const next = new Set<string>();
    for (let r = 0; r < this.rows; r++) next.add(cellKey(r, col));
    this.selectedCells = next;
    this.selectionAnchor = { row: 0, col };
  }

  // --- Backwards-compat derived getters ---
  // Renderer + interactivity still read these. New code should read
  // selectedCells directly.

  /** 'none' | 'cell' (single cell) | 'row' (entire single row) |
   *  'col' (entire single col) | 'multi' (anything else). */
  get selectionMode(): 'none' | 'cell' | 'row' | 'col' | 'multi' {
    const size = this.selectedCells.size;
    if (size === 0) return 'none';
    if (size === 1) return 'cell';
    const b = this.getSelectionBounds();
    if (!b) return 'multi';
    // Full single row: spans all cols, single row, fully filled
    if (b.minR === b.maxR && b.minC === 0 && b.maxC === this.cols - 1 && size === this.cols) {
      return 'row';
    }
    // Full single col
    if (b.minC === b.maxC && b.minR === 0 && b.maxR === this.rows - 1 && size === this.rows) {
      return 'col';
    }
    return 'multi';
  }

  get selectedCell(): { row: number; col: number } | null {
    if (this.selectedCells.size !== 1) return null;
    const key = this.selectedCells.values().next().value as string;
    return parseCellKey(key);
  }

  get selectedRow(): number {
    if (this.selectionMode !== 'row') return -1;
    return this.getSelectionBounds()!.minR;
  }

  get selectedCol(): number {
    if (this.selectionMode !== 'col') return -1;
    return this.getSelectionBounds()!.minC;
  }

  // --- Selection geometry helpers ---

  /** Tight bounding box around selected cells. Null if empty. */
  getSelectionBounds(): { minR: number; maxR: number; minC: number; maxC: number } | null {
    if (this.selectedCells.size === 0) return null;
    let minR = Infinity;
    let maxR = -Infinity;
    let minC = Infinity;
    let maxC = -Infinity;
    for (const key of this.selectedCells) {
      const p = parseCellKey(key);
      if (!p) continue;
      if (p.row < minR) minR = p.row;
      if (p.row > maxR) maxR = p.row;
      if (p.col < minC) minC = p.col;
      if (p.col > maxC) maxC = p.col;
    }
    return { minR, maxR, minC, maxC };
  }

  /** True if the bounding box is completely filled (no gaps).
   *  Gate for ops that require a contiguous rectangle (merge, copy). */
  isSelectionRectangular(): boolean {
    const b = this.getSelectionBounds();
    if (!b) return false;
    const expected = (b.maxR - b.minR + 1) * (b.maxC - b.minC + 1);
    return this.selectedCells.size === expected;
  }

  // --- GfxGroupCompatibleInterface ---

  get childIds(): string[] {
    return this._childIds;
  }

  get childElements(): GfxModel[] {
    const elements: GfxModel[] = [];
    for (const key of this._childIds) {
      const element =
        this.surface.getElementById(key) ||
        (this.surface.store.getModelById(key) as GfxBlockElementModel);
      if (element) elements.push(element);
    }
    return elements;
  }

  get descendantElements(): GfxModel[] {
    return this.childElements;
  }

  /** Resolve a child element by ID — works for both surface elements and block elements. */
  getChildById(id: string): GfxModel | null {
    return (
      this.surface.getElementById(id) ||
      (this.surface.store.getModelById(id) as GfxBlockElementModel) ||
      null
    );
  }

  setChildIds(value: string[], fromLocal: boolean) {
    const old = this._childIds;
    this._childIds = value;
    this._onChange({
      props: { childIds: value },
      oldValues: { childIds: old },
      local: fromLocal,
    });
  }

  hasChild(element: GfxModel): boolean {
    return this._childIds.includes(element.id);
  }

  hasDescendant(element: GfxModel): boolean {
    return this.hasChild(element);
  }

  // --- Computed dimensions (use preview fields during drag resize) ---

  /** Sanitize size arrays — corrupt saves (NaN / Infinity / <= 0) would
   *  propagate to xywh and render an invisible / unrecoverable grid. Replace
   *  bad entries with a default so the grid stays usable even after a bad
   *  load or a buggy peer mutation. */
  private _sanitizeSizes(arr: number[], fallback: number): number[] {
    let allClean = true;
    for (const v of arr) {
      if (!Number.isFinite(v) || v < 1) { allClean = false; break; }
    }
    if (allClean) return arr;
    return arr.map(v => (Number.isFinite(v) && v >= 1 ? v : fallback));
  }

  get effectiveColWidths(): number[] {
    return this._sanitizeSizes(this.previewColWidths ?? this.colWidths, 200);
  }

  get effectiveRowHeights(): number[] {
    return this._sanitizeSizes(this.previewRowHeights ?? this.rowHeights, 150);
  }

  get totalWidth(): number {
    const w = this.effectiveColWidths;
    return w.reduce((a, b) => a + b, 0) + Math.max(0, w.length - 1) * this.gap;
  }

  get totalHeight(): number {
    const h = this.effectiveRowHeights;
    return h.reduce((a, b) => a + b, 0) + Math.max(0, h.length - 1) * this.gap;
  }

  /** Recompute and store xywh from grid structure, preserving origin. */
  syncXYWH() {
    const [x, y] = this.deserializedXYWH;
    this.xywh = new Bound(x, y, this.totalWidth, this.totalHeight).serialize();
  }

  // --- Cell operations ---

  /** Pure getter — returns a zero-sized Bound at the grid origin for OOB
   *  input. Previously called clearSelection() here, which mutated state
   *  from inside a getter called every frame from the renderer (caused
   *  re-paint storms when selection went stale). Selection migration is now
   *  the responsibility of structural ops via _migrateSelectedCells, and
   *  the OOB Bound flows through the renderer harmlessly (zero-sized rects
   *  are no-ops in canvas paint). */
  getCellBound(row: number, col: number): Bound {
    const [originX, originY] = this.deserializedXYWH;
    const cw = this.effectiveColWidths;
    const rh = this.effectiveRowHeights;
    if (row < 0 || row >= rh.length || col < 0 || col >= cw.length) {
      return new Bound(originX, originY, 0, 0);
    }
    let x = originX;
    for (let c = 0; c < col; c++) x += cw[c] + this.gap;
    let y = originY;
    for (let r = 0; r < row; r++) y += rh[r] + this.gap;
    return new Bound(x, y, cw[col], rh[row]);
  }

  getCellAt(
    modelX: number,
    modelY: number
  ): { row: number; col: number } | null {
    const [originX, originY] = this.deserializedXYWH;
    const cw = this.effectiveColWidths;
    const rh = this.effectiveRowHeights;
    let x = originX;
    let col = -1;
    for (let c = 0; c < this.cols; c++) {
      if (modelX >= x && modelX < x + cw[c]) {
        col = c;
        break;
      }
      x += cw[c] + this.gap;
    }
    let y = originY;
    let row = -1;
    for (let r = 0; r < this.rows; r++) {
      if (modelY >= y && modelY < y + rh[r]) {
        row = r;
        break;
      }
      y += rh[r] + this.gap;
    }
    if (row < 0 || col < 0) return null;
    // Normalize through merge origins so callers always see the origin
    // (a merged region behaves as a single addressable cell).
    return this.getMergeOrigin(row, col);
  }

  getChildInCell(row: number, col: number): string | null {
    for (const [id, detail] of this.children.entries()) {
      if (detail.row === row && detail.col === col) return id;
    }
    return null;
  }

  // --- Cell style operations ---

  /** Legacy grids saved before cellStyles was added have no key in their yMap,
   *  so `@field()` returns undefined. Every accessor must guard. */
  getCellStyle(row: number, col: number): CellStyle | null {
    if (!this.cellStyles) return null;
    return this.cellStyles.get(cellKey(row, col)) ?? null;
  }

  getCellBgColor(row: number, col: number): Color | null {
    return this.getCellStyle(row, col)?.bgColor ?? null;
  }

  /** Caller is responsible for wrapping in a transact. */
  setCellStyle(row: number, col: number, style: CellStyle): void {
    // Bounds-check to prevent stale selections (e.g. from a not-yet-migrated
    // anchor) from writing entries outside the current grid that would
    // survive forever.
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    // Lazy-init for legacy grids loaded without a cellStyles field. The @field
    // setter writes the new Y.Map back into yMap inside the surrounding transact.
    if (!this.cellStyles) {
      this.cellStyles = new Y.Map<CellStyle>();
    }
    const key = cellKey(row, col);
    const prev = this.cellStyles.get(key) ?? {};
    const next: CellStyle = { ...prev, ...style };
    // Strip undefined entries so the map stays clean
    if (next.bgColor === undefined) delete next.bgColor;
    if (Object.keys(next).length === 0) {
      this.cellStyles.delete(key);
    } else {
      this.cellStyles.set(key, next);
    }
  }

  /** All cells inside the selection rectangle that contain children. Used by
   *  the merge action: ≤1 → safe to merge (any single non-origin child gets
   *  moved to the origin); ≥2 → ambiguous, merge disabled. Empty when the
   *  selection isn't rectangular. */
  getCellsWithChildrenInSelection(): Array<{
    row: number;
    col: number;
    childId: string;
  }> {
    const b = this.getSelectionBounds();
    if (!b || !this.isSelectionRectangular()) return [];
    const out: Array<{ row: number; col: number; childId: string }> = [];
    for (let r = b.minR; r <= b.maxR; r++) {
      for (let c = b.minC; c <= b.maxC; c++) {
        const childId = this.getChildInCell(r, c);
        if (childId) out.push({ row: r, col: c, childId });
      }
    }
    return out;
  }

  /** Distinct merge origins whose merged region intersects the selection
   *  bounds (covers user-selected cells that are either origins themselves
   *  or occluded by a merge that spills into the selection). Used by the
   *  Unmerge action. */
  getMergeOriginsInSelection(): Array<{ row: number; col: number }> {
    const b = this.getSelectionBounds();
    if (!b || !this.cellSpans || this.cellSpans.size === 0) return [];
    const seen = new Set<string>();
    const out: Array<{ row: number; col: number }> = [];
    for (let r = b.minR; r <= b.maxR; r++) {
      for (let c = b.minC; c <= b.maxC; c++) {
        const origin = this.getMergeOrigin(r, c);
        if (origin.row === r && origin.col === c) {
          // No-op normalization — only continue if this IS an origin.
          if (!this.getCellSpan(r, c)) continue;
        }
        const key = `${origin.row},${origin.col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(origin);
      }
    }
    return out;
  }

  /** Apply a style to every selected cell. */
  applyStyleToSelection(style: CellStyle): void {
    if (this.selectedCells.size === 0) return;
    const targets: Array<[number, number]> = [];
    for (const key of this.selectedCells) {
      const p = parseCellKey(key);
      if (p) targets.push([p.row, p.col]);
    }
    this.surface.store.transact(() => {
      for (const [r, c] of targets) this.setCellStyle(r, c, style);
    });
  }

  // --- Merge cell operations ---

  /** Span of the merge whose origin is exactly (r,c). Null if (r,c) is
   *  not a merge origin (either a plain cell, or a cell occluded by another
   *  merge). Legacy grids w/o cellSpans return null. */
  getCellSpan(row: number, col: number): CellSpan | null {
    if (!this.cellSpans) return null;
    return this.cellSpans.get(cellKey(row, col)) ?? null;
  }

  /** Walk cellSpans and return the origin (r,c) whose span contains the
   *  given cell, or the input itself if no merge contains it. */
  getMergeOrigin(row: number, col: number): { row: number; col: number } {
    if (!this.cellSpans || this.cellSpans.size === 0) return { row, col };
    for (const [key, span] of this.cellSpans.entries()) {
      const origin = parseCellKey(key);
      if (!origin) continue;
      if (
        row >= origin.row &&
        row < origin.row + span.rowSpan &&
        col >= origin.col &&
        col < origin.col + span.colSpan
      ) {
        return origin;
      }
    }
    return { row, col };
  }

  /** True if (r,c) is inside a merge but not its origin (i.e., the cell
   *  is visually consumed by another). */
  isOccluded(row: number, col: number): boolean {
    const origin = this.getMergeOrigin(row, col);
    return origin.row !== row || origin.col !== col;
  }

  /** Bound of a merged cell. Auto-normalizes (r,c) through `getMergeOrigin`
   *  so callers don't need to. For a plain cell returns the cell's own
   *  bound; for any cell inside a merge (origin or occluded) returns the
   *  full merged region. */
  getMergeBound(row: number, col: number): Bound {
    const origin = this.getMergeOrigin(row, col);
    const cb = this.getCellBound(origin.row, origin.col);
    const span = this.getCellSpan(origin.row, origin.col);
    if (!span || (span.rowSpan === 1 && span.colSpan === 1)) return cb;
    const cw = this.effectiveColWidths;
    const rh = this.effectiveRowHeights;
    let w = cb.w;
    for (let dc = 1; dc < span.colSpan && origin.col + dc < cw.length; dc++) {
      w += this.gap + cw[origin.col + dc];
    }
    let h = cb.h;
    for (let dr = 1; dr < span.rowSpan && origin.row + dr < rh.length; dr++) {
      h += this.gap + rh[origin.row + dr];
    }
    return new Bound(cb.x, cb.y, w, h);
  }

  /** Merge the rectangle [originR..originR+rowSpan-1] x [originC..originC+colSpan-1].
   *  Drops any existing merges that overlap the rectangle. Caller is responsible
   *  for ensuring the range is in-bounds and span >= 1. */
  mergeCells(
    originR: number,
    originC: number,
    rowSpan: number,
    colSpan: number
  ): void {
    if (rowSpan < 1 || colSpan < 1) return;
    if (rowSpan === 1 && colSpan === 1) return; // no-op
    if (originR < 0 || originC < 0) return;
    if (originR + rowSpan > this.rows || originC + colSpan > this.cols) return;
    this.surface.store.transact(() => {
      // Lazy-init for legacy grids loaded without cellSpans field.
      if (!this.cellSpans) {
        this.cellSpans = new Y.Map<CellSpan>();
      }
      // Drop pre-existing merges that overlap the new rectangle.
      const toDrop: string[] = [];
      for (const [key, span] of this.cellSpans.entries()) {
        const o = parseCellKey(key);
        if (!o) continue;
        const overlaps =
          o.row < originR + rowSpan &&
          o.row + span.rowSpan > originR &&
          o.col < originC + colSpan &&
          o.col + span.colSpan > originC;
        if (overlaps) toDrop.push(key);
      }
      if (toDrop.length > 0) {
        // The drop is intentional (caller has already accepted the new
        // rectangle), but surface it so any subsequent layout / undo
        // confusion is debuggable. UI surface (toast / dialog) is the
        // caller's responsibility — toolbar's `decideMergeState` already
        // gates this in the normal flow.
        console.log(
          `[grid] mergeCells(${originR},${originC},${rowSpan}x${colSpan}) ` +
            `dropping ${toDrop.length} overlapping merge(s): ${toDrop.join(', ')}`
        );
      }
      for (const k of toDrop) this.cellSpans.delete(k);
      this.cellSpans.set(cellKey(originR, originC), { rowSpan, colSpan });
      this._layout?.();
    });
  }

  /** Unmerge the merge whose origin is (originR, originC). No-op if not a
   *  merge origin. Caller wraps in transact if batching. */
  unmergeCells(originR: number, originC: number): void {
    if (!this.cellSpans) return;
    const key = cellKey(originR, originC);
    if (!this.cellSpans.has(key)) return;
    this.surface.store.transact(() => {
      this.cellSpans.delete(key);
      this._layout?.();
    });
  }

  /** Single entry point — runs every per-cell-keyed structure (cellStyles,
   *  selectedCells, and in P2: cellSpans) through the same remap callback.
   *  Call this inside each structural op (insertRow/Col, deleteRow/Col,
   *  reorder*). */
  private _migrateCellKeys(
    remap: (row: number, col: number) => { row: number; col: number } | null
  ): void {
    this._migrateCellStyles(remap);
    this._migrateSelectedCells(remap);
  }

  /** Rewrite cellSpans (Yjs) under a remap callback. Returning null drops the
   *  merge entirely. Span values are kept as-is — this is position-only,
   *  matching the V1 policy: structural ops that intersect a merge unmerge it,
   *  otherwise shift the origin.
   *
   *  Diff-based: only `delete` keys that aren't in the new target and `set`
   *  the (possibly shifted) keys — never `Y.Map.clear()`. clear() produces
   *  a bulk-delete op that Yjs UndoManager + concurrent peer edits don't
   *  always handle cleanly; per-key ops are individually undoable. */
  private _migrateCellSpans(
    remap: (
      originR: number,
      originC: number,
      span: CellSpan
    ) => { row: number; col: number } | null
  ): void {
    if (!this.cellSpans || this.cellSpans.size === 0) return;
    const target = new Map<string, CellSpan>();
    for (const [key, span] of this.cellSpans.entries()) {
      const origin = parseCellKey(key);
      if (!origin) continue;
      const remapped = remap(origin.row, origin.col, span);
      if (!remapped) continue;
      target.set(cellKey(remapped.row, remapped.col), span);
    }
    for (const oldKey of Array.from(this.cellSpans.keys())) {
      if (!target.has(oldKey)) this.cellSpans.delete(oldKey);
    }
    for (const [k, v] of target) this.cellSpans.set(k, v);
  }

  /** Rewrite selectedCells (transient Set) to follow row/col index shifts.
   *  Same remap protocol as _migrateCellStyles. Anchors are dropped if their
   *  target row/col vanished. */
  private _migrateSelectedCells(
    remap: (row: number, col: number) => { row: number; col: number } | null
  ): void {
    if (this.selectedCells.size === 0 && !this.selectionAnchor) return;
    const next = new Set<string>();
    for (const key of this.selectedCells) {
      const pos = parseCellKey(key);
      if (!pos) continue;
      const remapped = remap(pos.row, pos.col);
      if (!remapped) continue;
      next.add(cellKey(remapped.row, remapped.col));
    }
    this.selectedCells = next;
    if (this.selectionAnchor) {
      const a = remap(this.selectionAnchor.row, this.selectionAnchor.col);
      this.selectionAnchor = a ?? null;
    }
  }

  /** Rewrite cellStyles keys to follow row/col index shifts.
   *  Remap returns null to drop the entry. Diff-based: see _migrateCellSpans
   *  for the rationale (avoids Y.Map.clear). */
  private _migrateCellStyles(
    remap: (row: number, col: number) => { row: number; col: number } | null
  ): void {
    if (!this.cellStyles) return;
    const target = new Map<string, CellStyle>();
    for (const [key, value] of this.cellStyles.entries()) {
      const pos = parseCellKey(key);
      if (!pos) continue;
      const remapped = remap(pos.row, pos.col);
      if (!remapped) continue;
      target.set(cellKey(remapped.row, remapped.col), value);
    }
    for (const oldKey of Array.from(this.cellStyles.keys())) {
      if (!target.has(oldKey)) this.cellStyles.delete(oldKey);
    }
    for (const [k, v] of target) this.cellStyles.set(k, v);
  }

  // --- Child management ---

  addChild(element: GfxModel): void {
    this.addChildToCell(element, 0, 0);
  }

  addChildToCell(element: GfxModel, row: number, col: number) {
    // Reject nested grids — the outer grid's includesPoint override silences
    // the inner one's hit-test, making the inner grid permanently non-
    // interactive. Block at insert time rather than ship broken UX.
    if (element instanceof GridElementModel) return;
    if (!canSafeAddToContainer(this, element)) return;
    this.surface.store.transact(() => {
      this.children.set(element.id, { row, col });
      this._layout?.();
    });
  }

  removeChild(element: GfxModel) {
    this.surface.store.transact(() => {
      this.children.delete(element.id);
      this._layout?.();
    });
  }

  // --- Row/Col structural operations ---

  insertRow(afterIndex: number, height = 150) {
    this.surface.store.transact(() => {
      const h = [...this.rowHeights];
      h.splice(afterIndex + 1, 0, height);
      this.rowHeights = h;
      // rows derived from rowHeights.length — no manual sync needed
      const entries = Array.from(this.children.entries());
      for (const [id, d] of entries) {
        if (d.row > afterIndex) {
          this.children.set(id, { ...d, row: d.row + 1 });
        }
      }
      this._migrateCellKeys((r, c) =>
        r > afterIndex ? { row: r + 1, col: c } : { row: r, col: c }
      );
      // cellSpans: drop merges intersecting the insertion row, shift others.
      this._migrateCellSpans((r, _c, span) => {
        const r0 = r;
        const r1 = r + span.rowSpan - 1;
        if (afterIndex >= r0 && afterIndex < r1) return null; // intersects
        if (afterIndex < r0) return { row: r + 1, col: _c };
        return { row: r, col: _c };
      });
      this.syncXYWH();
      this._layout?.();
    });
  }

  insertCol(afterIndex: number, width = 200) {
    this.surface.store.transact(() => {
      const w = [...this.colWidths];
      w.splice(afterIndex + 1, 0, width);
      this.colWidths = w;
      // cols derived from colWidths.length — no manual sync needed
      const entries = Array.from(this.children.entries());
      for (const [id, d] of entries) {
        if (d.col > afterIndex) {
          this.children.set(id, { ...d, col: d.col + 1 });
        }
      }
      this._migrateCellKeys((r, c) =>
        c > afterIndex ? { row: r, col: c + 1 } : { row: r, col: c }
      );
      // cellSpans: drop merges intersecting the insertion col, shift others.
      this._migrateCellSpans((_r, c, span) => {
        const c0 = c;
        const c1 = c + span.colSpan - 1;
        if (afterIndex >= c0 && afterIndex < c1) return null;
        if (afterIndex < c0) return { row: _r, col: c + 1 };
        return { row: _r, col: c };
      });
      this.syncXYWH();
      this._layout?.();
    });
  }

  deleteRow(index: number) {
    if (this.rows <= 1) return;
    this.surface.store.transact(() => {
      const entries = Array.from(this.children.entries());
      for (const [id, d] of entries) {
        if (d.row === index) {
          // Delete the child element from canvas (not just unmap)
          this.children.delete(id);
          if (this.surface.hasElementById(id)) {
            this.surface.deleteElement(id);
          } else if (this.surface.store.hasBlock(id)) {
            this.surface.store.deleteBlock(id);
          }
        } else if (d.row > index) {
          this.children.set(id, { ...d, row: d.row - 1 });
        }
      }
      this._migrateCellKeys((r, c) => {
        if (r === index) return null;
        return r > index ? { row: r - 1, col: c } : { row: r, col: c };
      });
      // cellSpans: drop merges containing the deleted row; shift others.
      this._migrateCellSpans((r, _c, span) => {
        const r0 = r;
        const r1 = r + span.rowSpan - 1;
        if (index >= r0 && index <= r1) return null; // intersects merge → drop
        if (r > index) return { row: r - 1, col: _c };
        return { row: r, col: _c };
      });
      const h = [...this.rowHeights];
      h.splice(index, 1);
      this.rowHeights = h;
      this.syncXYWH();
      this._layout?.();
    });
  }

  deleteCol(index: number) {
    if (this.cols <= 1) return;
    this.surface.store.transact(() => {
      const entries = Array.from(this.children.entries());
      for (const [id, d] of entries) {
        if (d.col === index) {
          this.children.delete(id);
          if (this.surface.hasElementById(id)) {
            this.surface.deleteElement(id);
          } else if (this.surface.store.hasBlock(id)) {
            this.surface.store.deleteBlock(id);
          }
        } else if (d.col > index) {
          this.children.set(id, { ...d, col: d.col - 1 });
        }
      }
      this._migrateCellKeys((r, c) => {
        if (c === index) return null;
        return c > index ? { row: r, col: c - 1 } : { row: r, col: c };
      });
      // cellSpans: drop merges containing the deleted col; shift others.
      this._migrateCellSpans((_r, c, span) => {
        const c0 = c;
        const c1 = c + span.colSpan - 1;
        if (index >= c0 && index <= c1) return null;
        if (c > index) return { row: _r, col: c - 1 };
        return { row: _r, col: c };
      });
      const w = [...this.colWidths];
      w.splice(index, 1);
      this.colWidths = w;
      this.syncXYWH();
      this._layout?.();
    });
  }

  reorderRow(from: number, to: number) {
    if (from === to) return;
    this.surface.store.transact(() => {
      const h = [...this.rowHeights];
      const [moved] = h.splice(from, 1);
      h.splice(to, 0, moved);
      this.rowHeights = h;
      const entries = Array.from(this.children.entries());
      for (const [id, d] of entries) {
        let r = d.row;
        if (r === from) {
          r = to;
        } else if (from < to && r > from && r <= to) {
          r = r - 1;
        } else if (from > to && r >= to && r < from) {
          r = r + 1;
        }
        if (r !== d.row) this.children.set(id, { ...d, row: r });
      }
      this._migrateCellKeys((r, c) => {
        let newR = r;
        if (r === from) newR = to;
        else if (from < to && r > from && r <= to) newR = r - 1;
        else if (from > to && r >= to && r < from) newR = r + 1;
        return { row: newR, col: c };
      });
      // V1: row reorder drops ALL merges (avoids tangled span shift logic).
      this._migrateCellSpans(() => null);
      this._layout?.();
    });
  }

  reorderCol(from: number, to: number) {
    if (from === to) return;
    this.surface.store.transact(() => {
      const w = [...this.colWidths];
      const [moved] = w.splice(from, 1);
      w.splice(to, 0, moved);
      this.colWidths = w;
      const entries = Array.from(this.children.entries());
      for (const [id, d] of entries) {
        let c = d.col;
        if (c === from) {
          c = to;
        } else if (from < to && c > from && c <= to) {
          c = c - 1;
        } else if (from > to && c >= to && c < from) {
          c = c + 1;
        }
        if (c !== d.col) this.children.set(id, { ...d, col: c });
      }
      this._migrateCellKeys((r, c) => {
        let newC = c;
        if (c === from) newC = to;
        else if (from < to && c > from && c <= to) newC = c - 1;
        else if (from > to && c >= to && c < from) newC = c + 1;
        return { row: r, col: newC };
      });
      // V1: col reorder drops ALL merges.
      this._migrateCellSpans(() => null);
      this._layout?.();
    });
  }

  resizeRow(index: number, height: number) {
    // Bounds check — OOB index extends array with sparse holes which becomes
    // NaN in totalHeight and corrupts xywh. Can happen if grid shrunk
    // mid-drag (e.g., peer deleted row, undo replayed) and resize completes.
    if (index < 0 || index >= this.rowHeights.length) return;
    this.surface.store.transact(() => {
      const h = [...this.rowHeights];
      h[index] = Math.max(20, height);
      this.rowHeights = h;
      this.syncXYWH();
      this._layout?.();
    });
  }

  resizeCol(index: number, width: number) {
    if (index < 0 || index >= this.colWidths.length) return;
    this.surface.store.transact(() => {
      const w = [...this.colWidths];
      w[index] = Math.max(20, width);
      this.colWidths = w;
      this.syncXYWH();
      this._layout?.();
    });
  }

  // --- Layout ---

  setLayoutMethod(fn: () => void) {
    this._layout = fn;
  }

  layout() {
    this._layout?.();
  }

  // --- Hit testing ---

  override containsBound(bound: Bound): boolean {
    return bound.contains(Bound.deserialize(this.xywh));
  }

  override getLineIntersections(
    start: IVec,
    end: IVec
  ): PointLocation[] | null {
    const bound = Bound.deserialize(this.xywh);
    return linePolygonIntersects(start, end, bound.points);
  }

  override serialize() {
    return super.serialize() as SerializedGridElement;
  }
}
