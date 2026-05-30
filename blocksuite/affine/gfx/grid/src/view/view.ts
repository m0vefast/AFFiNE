import { GridElementModel } from '@blocksuite/affine-model';
import { Bound } from '@blocksuite/global/gfx';
import {
  type BoxSelectionContext,
  GfxControllerIdentifier,
  GfxElementModelView,
  GfxPrimitiveElementModel,
  GfxViewInteractionExtension,
} from '@blocksuite/std/gfx';

import { expandCellToFit, layoutGrid } from './layout.js';

export class GridView extends GfxElementModelView<GridElementModel> {
  static override type = 'grid';

  _layoutRunning = false;

  private _setLayoutMethod() {
    this.model.setLayoutMethod(() => {
      this._layoutRunning = true;
      try {
        layoutGrid(this.model);
      } finally {
        // try/finally: if layoutGrid throws, flag would stick true forever
        // → checkChildSizeChange permanently returns early, breaking the
        // auto-expand-to-fit feature for this grid instance.
        this._layoutRunning = false;
      }
    });
  }

  /** CSS that suppresses the default themed background of edgeless-text
   *  children whose home cell carries a non-transparent bgColor — so the
   *  cell's chosen color shows through cleanly. Pure render-time override;
   *  the child's data (color, hasMaxWidth, …) is untouched, undo-safe.
   *  Re-emitted from `updateGridCellCSS()` on cellStyles / children change. */
  private _transparentChildBgRules(): string {
    if (!this.model.cellStyles || this.model.cellStyles.size === 0) return '';
    const ids: string[] = [];
    for (const [childId, detail] of this.model.children.entries()) {
      const style = this.model.cellStyles.get(`${detail.row},${detail.col}`);
      const bg = style?.bgColor as unknown;
      if (!bg) continue;
      // Treat any explicit value other than the literal string 'transparent'
      // (or an object with both light/dark = transparent) as a real color.
      // False positives are harmless — we just transparentize the child bg
      // for a basically-transparent cell, with no visible difference.
      const isTransparent =
        bg === 'transparent' ||
        (typeof bg === 'object' &&
          bg !== null &&
          (bg as { light?: string; dark?: string }).light === 'transparent' &&
          (bg as { light?: string; dark?: string }).dark === 'transparent');
      if (isTransparent) continue;
      ids.push(CSS.escape(childId));
    }
    if (ids.length === 0) return '';
    // Target the host + the common inner containers/blocks that own a
    // theme background. Cannot use `*` — it would also nuke inline-text
    // highlight backgrounds (selection, comment highlight) which we want
    // to keep visible.
    const hostSel = ids.map(id => `affine-edgeless-text[data-block-id="${id}"]`).join(',\n');
    const innerSel = ids
      .flatMap(id => [
        `affine-edgeless-text[data-block-id="${id}"] .edgeless-text-block-container`,
        `affine-edgeless-text[data-block-id="${id}"] .affine-block-children-container`,
        `affine-edgeless-text[data-block-id="${id}"] affine-paragraph`,
        `affine-edgeless-text[data-block-id="${id}"] affine-list`,
        `affine-edgeless-text[data-block-id="${id}"] affine-note`,
        `affine-edgeless-text[data-block-id="${id}"] rich-text`,
        `affine-edgeless-text[data-block-id="${id}"] .inline-editor`,
        `affine-edgeless-text[data-block-id="${id}"] .affine-paragraph-block-container`,
        `affine-edgeless-text[data-block-id="${id}"] .affine-paragraph-rich-text-wrapper`,
      ])
      .join(',\n');
    return `${hostSel} {
      background-color: transparent !important;
      background: transparent !important;
    }
    ${innerSel} {
      background-color: transparent !important;
      background: transparent !important;
    }`;
  }

  /** Drop `selectedCells` / `selectionAnchor` entries that point at rows or
   *  columns no longer in bounds. Used to repair transient selection state
   *  after a peer-driven row/col delete shrinks the grid. */
  private _dropOobSelection() {
    const { rows, cols } = this.model;
    const stale: string[] = [];
    for (const key of this.model.selectedCells) {
      const i = key.indexOf(',');
      if (i < 0) { stale.push(key); continue; }
      const r = Number(key.slice(0, i));
      const c = Number(key.slice(i + 1));
      if (!Number.isInteger(r) || !Number.isInteger(c) || r >= rows || c >= cols) {
        stale.push(key);
      }
    }
    if (stale.length > 0) {
      const next = new Set(this.model.selectedCells);
      for (const k of stale) next.delete(k);
      this.model.selectedCells = next;
    }
    const a = this.model.selectionAnchor;
    if (a && (a.row >= rows || a.col >= cols)) {
      this.model.selectionAnchor = null;
    }
  }

  /** Suppress leak-revert briefly after we ourselves set framework selection,
   *  so the subscriber doesn't fight with our own writes. Uses monotonic
   *  performance.now() so wall-clock jumps (NTP/DST) can't shrink the window. */
  private _suppressRevertUntil = 0;
  /** Memo: last `drilledId` we passed to updateChildHitTest. Selection
   *  updates that don't change the drilled child (the common case — every
   *  click that doesn't enter/exit L3) skip the per-child defineProperty
   *  loop entirely. */
  private _lastDrilledChildId: string | null | undefined = undefined;

  override onCreated(): void {
    this._setLayoutMethod();

    // Layout is called inside each structural method's transact for undo atomicity.
    // The only reactive trigger is for grid POSITION changes (framework drag-move).
    this.disposable.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === 'xywh') {
          this.model.layout();
        }
        // Peer-driven row/col delete shrinks rows/cols. Our local
        // `selectedCells` (transient @local Set, not Yjs-synced) keeps the
        // pre-shrink keys → renderer paints orange borders on OOB rows and
        // the toolbar reports the wrong selectionMode. Local structural
        // ops already remap inside their transact; only peer ops need this.
        // We can't infer the deleted index from the new length, so we drop
        // OOB cells rather than try to shift — partial preservation is more
        // user-friendly than wholesale clear.
        if (key === 'rowHeights' || key === 'colWidths') {
          this._dropOobSelection();
        }
      })
    );

    // ── Layer leak-revert ────────────────────────────────────────────
    // 3-layer selection contract:
    //   L1 grid framework-selected, no cells
    //   L2 grid framework-selected + cells selected (model.selectedCells)
    //   L3 a child of this grid is framework-selected (drilled in)
    //
    // The framework's element-at-point picks the topmost element under the
    // cursor — when a cell contains a child, the framework lands on the CHILD
    // and either replaces (plain click) or extends (shift) framework selection
    // to include it. That breaks our layering: L2 ends up as [grid, child]
    // (Frame/Group multi-toolbar) or [child only] when the user really meant
    // to select the cell. We listen on selection updates and:
    //   - [grid + our child(ren)]  → revert to [grid]  (the L2-extends-but-
    //                                  framework-grabbed-child case)
    //   - [our child only] AND model has cell selection → revert to [grid]
    //                                  (single click on a cell whose content
    //                                  happens to fill it — first click must
    //                                  always select the cell, never the child)
    //   - [our child only] AND model has NO cell selection → allow
    //                                  (intentional L3 drill via double-click
    //                                  on a selected cell with content)
    this.disposable.add(
      this.gfx.selection.slots.updated.subscribe(() => {
        if (performance.now() <= this._suppressRevertUntil) return;
        const selected = this.gfx.selection.selectedElements;
        const includesMe = selected.some(e => e.id === this.model.id);
        const ourChildren = selected.filter(e =>
          this.model.children.has(e.id)
        );

        // Case 0: framework selection has nothing referencing this grid or
        // its children (empty, sibling grid, or unrelated element). Any
        // stale cell selection on us is now visually inconsistent — we'd
        // keep painting orange cell highlights on a grid the user isn't
        // focused on. Clear it.
        if (!includesMe && ourChildren.length === 0) {
          if (this.model.selectedCells.size > 0) {
            this.model.clearSelection();
          }
          return;
        }

        // Case 1: grid + child(ren) of grid both in framework selection.
        if (includesMe && ourChildren.length > 0) {
          this._suppressRevertUntil = performance.now() + 50;
          this.gfx.selection.set({
            elements: [this.model.id],
            editing: false,
          });
          // Sync hit-test immediately. If slots.updated fires async, the
          // sibling updateChildHitTest subscriber would otherwise observe
          // the OLD (leaked) selection and briefly make a child hit-testable.
          updateChildHitTest(true);
          return;
        }

        // Includes me, no children → normal L1/L2 state. Nothing to revert.
        if (includesMe) return;

        // Case 2 vs 3: framework has just child(ren) of ours, no grid.
        // Drilled (allow) only when model has zero cell selection.
        if (this.model.selectedCells.size === 0) return;

        this._suppressRevertUntil = performance.now() + 50;
        this.gfx.selection.set({
          elements: [this.model.id],
          editing: false,
        });
        updateChildHitTest(true);
      })
    );

    // Clean up orphaned Y.Map entries when a child is deleted externally
    // Surface elements:
    // If a drilled child gets deleted (locally or by a peer over Yjs),
    // framework selection still references the dead id → phantom selection,
    // grid toolbar hidden. Clear framework selection back to [grid].
    //
    // IMPORTANT order: check framework selection independently of children
    // map membership. deleteRow / deleteCol mutate `children.delete(id)`
    // BEFORE firing surface.elementRemoved → by the time we get here,
    // children.has(id) is already false. Without the independent check we'd
    // skip framework-selection cleanup for exactly the structural-delete
    // path that needs it most.
    const handleChildRemoved = (id: string) => {
      const wasOurs = this.model.children.has(id);
      if (wasOurs) this.model.removeChild({ id } as any);
      const selected = this.gfx.selection.selectedElements;
      if (
        (wasOurs || this._lastDrilledChildId === id) &&
        selected.length === 1 &&
        selected[0].id === id
      ) {
        this.gfx.selection.set({ elements: [this.model.id], editing: false });
      }
    };
    this.disposable.add(
      this.surface.elementRemoved.subscribe(({ id }) => handleChildRemoved(id))
    );
    // Block elements (edgeless-text, YouTube embed, etc.):
    this.disposable.add(
      this.model.surface.store.slots.blockUpdated.subscribe(({ type, id }) => {
        if (type === 'delete') handleChildRemoved(id);
      })
    );

    // Watch child element SIZE changes → auto-expand cell to fit.
    // Skip changes caused by our own layout (which stretches elements to fill cells).
    const checkChildSizeChange = (id: string) => {
      if (this._layoutRunning) return; // Skip changes from layout itself
      if (!this.model.children.has(id)) return;

      const element = this.model.getChildById(id);
      if (!element) return;

      const detail = this.model.children.get(id);
      if (!detail) return;

      // Children in merge origins are stretched by layoutGrid to span the full
      // merged region — never auto-expand columns/rows beneath them, or we get
      // a feedback loop (resizeCol → layout → larger xywh → resizeCol → ...).
      if (this.model.getCellSpan(detail.row, detail.col)) return;

      const elBound = element.elementBound;
      expandCellToFit(
        this.model,
        detail.row,
        detail.col,
        elBound.w,
        elBound.h
      );
    };

    // Watch surface element changes (shapes, canvas text, etc.)
    this.disposable.add(
      this.surface.elementUpdated.subscribe(({ id, props, local }) => {
        if (!local || !('xywh' in props)) return;
        checkChildSizeChange(id);
      })
    );

    // Watch block element changes (edgeless-text, YouTube embed, etc.).
    // Mirror elementUpdated's guard: only react to LOCAL xywh changes —
    // a peer's xywh edit would otherwise trigger our local expandCellToFit
    // → resizeCol/Row writes on every client. Each client re-broadcasts.
    // Echo storm + spurious undo entries.
    this.disposable.add(
      this.model.surface.store.slots.blockUpdated.subscribe(payload => {
        if (payload.type !== 'update') return;
        if (!payload.isLocal) return;
        if (payload.props?.key !== 'xywh') return;
        checkChildSizeChange(payload.id);
      })
    );

    // Disable connector attachment on grid children.
    // Block elements: writable `connectable` property.
    // Surface elements: getter — shadow with defineProperty.
    const setConnectable = (id: string, value: boolean) => {
      const el = this.model.getChildById(id);
      if (!el) return;
      if (el instanceof GfxPrimitiveElementModel) {
        if (value) {
          // Remove the shadow property, restoring the prototype getter (returns true)
          delete (el as any).connectable;
        } else {
          Object.defineProperty(el, 'connectable', { value: false, configurable: true });
        }
      } else {
        (el as any).connectable = value;
      }
    };

    // ── Framework hit-test override on children ────────────────────────
    // Single unified rule for the 3-layer state machine: framework's
    // element-at-point may only land on (a) the grid itself, or (b) the
    // ACTIVELY DRILLED child (Layer 3 — the lone framework-selected child
    // of this grid). Every other child is forced to report
    // `includesPoint() === false`, so framework never even sees them as
    // click candidates. Without this, framework hit-test picks the topmost
    // child under the cursor → wrong selection layer for 1 frame → flicker
    // and side effects before the leak-revert listener catches up.
    const setHitTestable = (id: string, hitTestable: boolean) => {
      const el = this.model.getChildById(id);
      if (!el) return;
      if (hitTestable) {
        // Restore prototype implementation
        delete (el as any).includesPoint;
      } else {
        Object.defineProperty(el, 'includesPoint', {
          value: () => false,
          configurable: true,
          writable: true,
        });
      }
    };
    const updateChildHitTest = (force = false) => {
      const fwSel = this.gfx.selection.selectedElements;
      const drilledId =
        fwSel.length === 1 && this.model.children.has(fwSel[0].id)
          ? fwSel[0].id
          : null;
      // Memoize: every click fires this listener (on N grids). Skip the
      // per-child defineProperty loop when the drilled child hasn't changed.
      if (!force && drilledId === this._lastDrilledChildId) return;
      for (const childId of this.model.children.keys()) {
        setHitTestable(childId, childId === drilledId);
      }
      // Cache AFTER the loop — if setHitTestable throws midway, next call
      // re-runs the full pass instead of memo'ing an inconsistent state.
      this._lastDrilledChildId = drilledId;
    };

    // Initial pass — apply to children already in the grid at mount time.
    for (const id of this.model.children.keys()) {
      setConnectable(id, false);
    }
    updateChildHitTest();

    // ── Shadow-prop restoration on view destroy ───────────────────────
    // `setConnectable(id, false)` and `setHitTestable(id, false)` install
    // non-enumerable shadow `includesPoint`/`connectable` on child models
    // via Object.defineProperty. If the grid is deleted directly through
    // `surface.deleteElement(gridId)` (which doesn't cascade because grid
    // is GfxPrimitiveElementModel, not GfxGroupLikeElementModel — the
    // `gfxGroupCompatibleSymbol` flag is not enough for cascade), the
    // children survive on canvas with `includesPoint: () => false`
    // permanently shadowed → un-clickable until page reload.
    // No production callsite triggers this today (Glyph delete paths go
    // through edgeless service which walks descendantElements), but the
    // defense-in-depth cost is one disposable.
    this.disposable.add({
      dispose: () => {
        for (const id of this.model.children.keys()) {
          setHitTestable(id, true);
          setConnectable(id, true);
        }
      },
    });

    // React to children added / removed: keep both overrides in sync.
    // Y.Map.observe returns void — must explicitly unobserve(sameFn) on
    // dispose, otherwise the subscription accumulates on every re-mount.
    const childrenOverrideFn = (evt: any) => {
      for (const key of evt.keysChanged) {
        if (this.model.children.has(key)) {
          setConnectable(key, false);
        } else {
          // Child removed from grid — restore both default behaviors
          setConnectable(key, true);
          setHitTestable(key, true);
        }
      }
      // Force refresh — new/removed children require iterating regardless
      // of memoized drilled id.
      updateChildHitTest(true);
    };
    this.model.children.observe(childrenOverrideFn);
    this.disposable.add({
      dispose: () => this.model.children.unobserve(childrenOverrideFn),
    });

    // React to framework selection changes: drilled child becomes hit-
    // testable; previous drilled child (if any) becomes invisible again.
    this.disposable.add(
      this.gfx.selection.slots.updated.subscribe(() => updateChildHitTest())
    );

    // Dynamic CSS for grid-cell embeds: target children by data-block-id
    // so the embed height override only applies inside grid cells.
    // Remove any stale style element for this grid id (defensive against
    // re-mount paths: tab park/restore, extension hot-reload — without this
    // each cycle appends a duplicate <style> with ~50 selectors that never
    // gets reaped).
    // CSS.escape: model.id is Yjs-generated in normal use, but a peer-synced
    // .glyph could carry attacker-controlled ids that break the selector or
    // inject extra rules. Cheap defensive escape.
    document.head
      .querySelectorAll(`style[data-grid-id="${CSS.escape(this.model.id)}"]`)
      .forEach(s => s.remove());
    const gridStyleEl = document.createElement('style');
    gridStyleEl.dataset.gridId = this.model.id;
    document.head.appendChild(gridStyleEl);
    this.disposable.add({ dispose: () => gridStyleEl.remove() });

    const updateGridCellCSS = () => {
      const ids = Array.from(this.model.children.keys()).map(id => CSS.escape(id));
      if (ids.length === 0) { gridStyleEl.textContent = ''; return; }
      // Build selectors scoped to this grid's children only.
      // Child ids escaped above to neutralize attacker-controlled values
      // from peer-synced documents.
      const s = (suffix: string) =>
        ids.map(id => `affine-edgeless-text[data-block-id="${id}"]${suffix}`).join(',\n');
      gridStyleEl.textContent = `
        ${s(':has(.embed-block-container) > .edgeless-text-block-container')} {
          height: 100%; display: flex; flex-direction: column;
        }
        ${s(':has(.embed-block-container) > .edgeless-text-block-container > div')} {
          flex: 1; display: flex; flex-direction: column; min-height: 0;
        }
        ${s(':has(.embed-block-container) .affine-block-children-container')} {
          flex: 1 !important; display: flex !important; flex-direction: column !important; min-height: 0;
        }
        ${s(' :has(> .affine-block-component > .embed-block-container)')} {
          flex: 1; display: flex; flex-direction: column; min-height: 0;
        }
        ${s(' .affine-block-component:has(> .embed-block-container)')} {
          flex: 1; display: flex; flex-direction: column; margin: 0 !important; min-height: 0;
        }
        ${s(':has(.embed-block-container) .embed-block-container')} {
          flex: 1; height: auto !important; min-height: 0;
        }

        /* Attachment (PDF) embed view — same flex-fill chain, different container class */
        ${s(':has(.affine-attachment-embed-container) > .edgeless-text-block-container')} {
          height: 100%; display: flex; flex-direction: column;
        }
        ${s(':has(.affine-attachment-embed-container) > .edgeless-text-block-container > div')} {
          flex: 1; display: flex; flex-direction: column; min-height: 0;
        }
        ${s(':has(.affine-attachment-embed-container) .affine-block-children-container')} {
          flex: 1 !important; display: flex !important; flex-direction: column !important; min-height: 0;
        }
        ${s(' :has(> .affine-block-component > .affine-attachment-container)')} {
          flex: 1; display: flex; flex-direction: column; min-height: 0;
        }
        ${s(' .affine-block-component:has(> .affine-attachment-container)')} {
          flex: 1; display: flex; flex-direction: column; margin: 0 !important; min-height: 0;
        }
        ${s(':has(.affine-attachment-embed-container) .affine-attachment-container')} {
          flex: 1; height: auto !important; min-height: 0; display: flex; flex-direction: column;
        }
        ${s(':has(.affine-attachment-embed-container) .affine-attachment-embed-container')} {
          flex: 1; height: auto !important; min-height: 0;
        }

        /* embed-iframe — same flex-fill chain */
        ${s(':has(.affine-embed-iframe-block-container) > .edgeless-text-block-container')} {
          height: 100%; display: flex; flex-direction: column;
        }
        ${s(':has(.affine-embed-iframe-block-container) > .edgeless-text-block-container > div')} {
          flex: 1; display: flex; flex-direction: column; min-height: 0;
        }
        ${s(':has(.affine-embed-iframe-block-container) .affine-block-children-container')} {
          flex: 1 !important; display: flex !important; flex-direction: column !important; min-height: 0;
        }
        ${s(' :has(> .affine-block-component > .affine-embed-iframe-block-container)')} {
          flex: 1; display: flex; flex-direction: column; min-height: 0;
        }
        ${s(' .affine-block-component:has(> .affine-embed-iframe-block-container)')} {
          flex: 1; display: flex; flex-direction: column; margin: 0 !important; min-height: 0;
        }
        ${s(':has(.affine-embed-iframe-block-container) .affine-embed-iframe-block-container')} {
          flex: 1; height: auto !important; min-height: 0;
        }
        ${this._transparentChildBgRules()}
      `;
    };
    updateGridCellCSS();
    const childrenCssFn = () => updateGridCellCSS();
    this.model.children.observe(childrenCssFn);
    this.disposable.add({
      dispose: () => this.model.children.unobserve(childrenCssFn),
    });
    // Re-emit CSS when the per-cell style version bumps (color picker
    // `end`, merge/unmerge, …). We deliberately do NOT subscribe to
    // `cellStyles.observe` directly — the color picker fires 60×/sec
    // during drag, and regenerating the full per-child selector block
    // every tick is what made bg-color application feel "minutes long".
    this.disposable.add(
      this.model.propsUpdated.subscribe(({ key }) => {
        if (key === 'styleVersion') updateGridCellCSS();
      })
    );

    // Initial layout
    this.model.layout();
  }

  override onBoxSelected(context: BoxSelectionContext) {
    const { box } = context;
    const bound = new Bound(box.x, box.y, box.w, box.h);
    return bound.contains(this.model.elementBound);
  }
}

export const GridInteraction = GfxViewInteractionExtension<GridView>(
  GridView.type,
  {
    // Enable all 8 resize handles (4 corners + 4 edges)
    resizeConstraint: {
      minWidth: 60,
      minHeight: 40,
    },

    // Proportional resize: distribute delta across colWidths/rowHeights
    handleResize: ({ model }) => {
      const grid = model as unknown as GridElementModel;
      let origW: number;
      let origH: number;
      let origColWidths: number[];
      let origRowHeights: number[];

      return {
        onResizeStart() {
          origW = grid.totalWidth;
          origH = grid.totalHeight;
          origColWidths = [...grid.colWidths];
          origRowHeights = [...grid.rowHeights];
        },
        onResizeMove(ctx) {
          const newW = ctx.newBound.w;
          const newH = ctx.newBound.h;

          const scaleX = origW > 0 ? newW / origW : 1;
          const scaleY = origH > 0 ? newH / origH : 1;

          const newColWidths = origColWidths.map(w =>
            Math.max(20, Math.round(w * scaleX))
          );
          const newRowHeights = origRowHeights.map(h =>
            Math.max(20, Math.round(h * scaleY))
          );

          // Preview via @local — no Yjs write during drag
          grid.previewColWidths = newColWidths;
          grid.previewRowHeights = newRowHeights;
          grid.layout();
        },
        onResizeEnd() {
          // Clear preview
          const finalColWidths = grid.previewColWidths ?? grid.colWidths;
          const finalRowHeights = grid.previewRowHeights ?? grid.rowHeights;
          grid.previewColWidths = null;
          grid.previewRowHeights = null;

          // Single Yjs commit
          grid.surface.store.transact(() => {
            grid.colWidths = [...finalColWidths];
            grid.rowHeights = [...finalRowHeights];
            grid.syncXYWH();
            grid.layout();
          });
        },
      };
    },

    handleSelection: ({ model, std }) => ({
      onSelect(context) {
        // Sub-space selection contract: cell-level selection is OUR concern
        // (selectedCells Set, populated by pointerdown via selectCell /
        // selectCellRange — shift+click extends to a range; cmd/ctrl is
        // intentionally not a disjoint multi-select). The framework-level
        // selection MUST stay pinned to [grid] whenever a modifier key is
        // down — otherwise framework default's multiSelect branch would
        // (a) toggle the grid out of selection, (b) pick up whatever child
        // element happens to live in that cell — switching the toolbar
        // flavour off 'affine:surface:grid' and replacing our merge /
        // bg-color actions with the generic multi-element bar
        // (Frame/Group/lock/…).
        const evt = context.event;
        if (evt && (evt.shiftKey || evt.metaKey || evt.ctrlKey)) {
          // Belt-and-suspenders: re-pin framework selection to [grid] so any
          // drift from other code paths (e.g. external selection mutations
          // racing in) is corrected.
          std.get(GfxControllerIdentifier).selection.set({
            elements: [model.id],
            editing: false,
          });
          return true;
        }
        // Plain click — let framework do its default (selects the grid).
        return context.default(context);
      },
    }),
  }
);
