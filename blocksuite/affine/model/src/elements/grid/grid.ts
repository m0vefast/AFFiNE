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

type GridElementProps = BaseElementProps & {
  children: Y.Map<CellDetail>;
};

export type SerializedGridElement = SerializedElement & {
  children: Record<string, CellDetail>;
};

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

  /** Current selection mode within the grid. */
  @local()
  accessor selectionMode: 'none' | 'cell' | 'row' | 'col' = 'none';

  /** Selected cell (when selectionMode='cell'). */
  @local()
  accessor selectedCell: { row: number; col: number } | null = null;

  /** Selected row index (when selectionMode='row'). */
  @local()
  accessor selectedRow: number = -1;

  /** Selected column index (when selectionMode='col'). */
  @local()
  accessor selectedCol: number = -1;

  clearSelection() {
    this.selectionMode = 'none';
    this.selectedCell = null;
    this.selectedRow = -1;
    this.selectedCol = -1;
  }

  selectCell(row: number, col: number) {
    this.selectionMode = 'cell';
    this.selectedCell = { row, col };
    this.selectedRow = -1;
    this.selectedCol = -1;
  }

  selectRow(row: number) {
    this.selectionMode = 'row';
    this.selectedCell = null;
    this.selectedRow = row;
    this.selectedCol = -1;
  }

  selectCol(col: number) {
    this.selectionMode = 'col';
    this.selectedCell = null;
    this.selectedRow = -1;
    this.selectedCol = col;
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

  get effectiveColWidths(): number[] {
    return this.previewColWidths ?? this.colWidths;
  }

  get effectiveRowHeights(): number[] {
    return this.previewRowHeights ?? this.rowHeights;
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

  getCellBound(row: number, col: number): Bound {
    const [originX, originY] = this.deserializedXYWH;
    const cw = this.effectiveColWidths;
    const rh = this.effectiveRowHeights;
    // Guard against stale selection indices after undo
    if (row < 0 || row >= rh.length || col < 0 || col >= cw.length) {
      this.clearSelection();
      return new Bound(originX, originY, cw[0] ?? 100, rh[0] ?? 100);
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
    return { row, col };
  }

  getChildInCell(row: number, col: number): string | null {
    for (const [id, detail] of this.children.entries()) {
      if (detail.row === row && detail.col === col) return id;
    }
    return null;
  }

  // --- Child management ---

  addChild(element: GfxModel): void {
    this.addChildToCell(element, 0, 0);
  }

  addChildToCell(element: GfxModel, row: number, col: number) {
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
      this._layout?.();
    });
  }

  resizeRow(index: number, height: number) {
    this.surface.store.transact(() => {
      const h = [...this.rowHeights];
      h[index] = Math.max(20, height);
      this.rowHeights = h;
      this.syncXYWH();
      this._layout?.();
    });
  }

  resizeCol(index: number, width: number) {
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
