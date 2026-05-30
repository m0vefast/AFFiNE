import {
  packColor,
  type PickColorEvent,
} from '@blocksuite/affine-components/color-picker';
import {
  type Color,
  GridElementModel,
  resolveColor,
} from '@blocksuite/affine-model';
import {
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from '@blocksuite/affine-shared/services';
import { BlockFlavourIdentifier } from '@blocksuite/std';
import { WarningIcon } from '@blocksuite/icons/lit';
import { html } from 'lit';


/** Iterate the selectedCells Set as (row, col) pairs. */
function selectionCells(
  model: GridElementModel
): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  for (const key of model.selectedCells) {
    const i = key.indexOf(',');
    if (i < 0) continue;
    const row = Number(key.slice(0, i));
    const col = Number(key.slice(i + 1));
    if (Number.isInteger(row) && Number.isInteger(col)) out.push({ row, col });
  }
  return out;
}

/** Count "logical" cells in the selection. Each merge region counts as 1
 *  (regardless of its span), plus each unmerged 1×1 cell. Drives the
 *  unified merge/unmerge visibility rule:
 *    >1 logical cells  → MERGE only   (combine into one)
 *    =1 logical merge  → UNMERGE only (split it back)
 *    =1 single unmerged cell → neither
 *  Examples (selection contents → logical count):
 *    [a,b,c,d,e] 5 plain cells               → 5  → MERGE
 *    [merge(2)+c+d+e] 1 merge + 3 plain      → 4  → MERGE
 *    [merge(3)] selection == single merge    → 1  → UNMERGE
 *    [merge(2)+merge(2)] 2 separate merges   → 2  → MERGE (combine merges) */
function countLogicalCells(model: GridElementModel): number {
  const origins = new Set<string>();
  let unmerged = 0;
  for (const key of model.selectedCells) {
    const i = key.indexOf(',');
    if (i < 0) continue;
    const r = Number(key.slice(0, i));
    const c = Number(key.slice(i + 1));
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    const origin = model.getMergeOrigin(r, c);
    if (model.getCellSpan(origin.row, origin.col)) {
      origins.add(`${origin.row},${origin.col}`);
    } else {
      unmerged++;
    }
  }
  return origins.size + unmerged;
}

/** Gate for *showing* the Merge button. Rectangular requirement stays
 *  (mergeCells writes a single rect); the unified rule decides the rest. */
function mergeButtonVisible(model: GridElementModel): boolean {
  if (!model.isSelectionRectangular()) return false;
  return countLogicalCells(model) > 1;
}

/** Unmerge visible only when selection collapses to a single logical cell
 *  that IS a merge. Hides whenever merge is shown — the two are mutually
 *  exclusive under the unified rule. */
function unmergeButtonVisible(model: GridElementModel): boolean {
  if (countLogicalCells(model) !== 1) return false;
  return model.getMergeOriginsInSelection().length === 1;
}

/** Decide Merge button state given current selection.
 *  - contentCells = cells in selection range that already contain a child
 *  - Rule: allow merge when contentCells.length ≤ 1 (the single content cell,
 *    wherever it is, ends up at the merge origin); disable when ≥ 2 (ambiguous
 *    which content would "win"). */
function decideMergeState(model: GridElementModel): {
  contentCells: Array<{ row: number; col: number; childId: string }>;
  disabled: boolean;
} {
  const contentCells = model.getCellsWithChildrenInSelection();
  return { contentCells, disabled: contentCells.length >= 2 };
}

export const gridToolbarConfig = {
  actions: [
    {
      id: 'a.cell-bg-color',
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(GridElementModel);
        return models.some(m => m.selectedCells.size > 0);
      },
      content(ctx) {
        const models = ctx.getSurfaceModelsByType(GridElementModel);
        const active = models.find(m => m.selectedCells.size > 0);
        if (!active) return null;

        const enableCustomColor = ctx.features.getFlag('enable_color_picker');
        const theme = ctx.theme.edgeless$.value;

        // Show the first selected cell's current bg on the picker (or grid
        // fillColor fallback).
        const cells = selectionCells(active);
        const firstCellBg = cells.length
          ? active.getCellBgColor(cells[0].row, cells[0].col)
          : null;
        const sourceColor: Color = firstCellBg ?? active.fillColor;
        const originalColor = sourceColor;
        const color = resolveColor(sourceColor, theme);

        const mode = active.selectionMode;
        const label =
          mode === 'cell'
            ? 'Cell background'
            : mode === 'row'
              ? 'Row background'
              : mode === 'col'
                ? 'Column background'
                : `${active.selectedCells.size} cells background`;

        const onPick = (e: PickColorEvent) => {
          // Guard: grid may have been deleted (peer Yjs delete, undo) between
          // toolbar render and this event. Writing through a detached model
          // throws inside Yjs transact and corrupts undo state.
          if (!ctx.std.store.hasBlock(active.surface.id)) return;
          if (!ctx.gfx.getElementById(active.id)) return;
          switch (e.type) {
            case 'start':
              ctx.store.captureSync();
              break;
            case 'pick': {
              const value = e.detail.value;
              const { bgColor } = packColor('bgColor', value) as {
                bgColor: Color;
              };
              ctx.store.transact(() => {
                for (const { row, col } of selectionCells(active)) {
                  active.setCellStyle(row, col, { bgColor });
                }
              });
              break;
            }
            case 'end':
              // Force toolbar widget re-render so the pill reflects the
              // final committed color. Bumping during 'pick' would re-render
              // 60×/sec and re-mount the picker mid-drag, killing the drag
              // state (and making the change feel like it takes "minutes"
              // because each pick fights the picker's internal state).
              active.bumpStyleVersion();
              break;
          }
        };

        return html`
          <edgeless-color-picker-button
            class="cell-bg"
            .label="${label}"
            .pick=${onPick}
            .color=${color}
            .theme=${theme}
            .originalColor=${originalColor}
            .enableCustomColor=${enableCustomColor}
          >
          </edgeless-color-picker-button>
        `;
      },
    },
    {
      id: 'b.merge-cells',
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(GridElementModel);
        return models.some(mergeButtonVisible);
      },
      content(ctx) {
        const models = ctx.getSurfaceModelsByType(GridElementModel);
        const active = models.find(mergeButtonVisible);
        if (!active) return null;

        const { contentCells, disabled } = decideMergeState(active);

        // Structured tooltip — distinct treatment for blocked vs ready states.
        // Blocked: warning headline + cell count + clear action hint.
        // Single-content ready: explains the auto-collect behavior so the
        //   user knows nothing will be lost.
        // Plain ready: simple label.
        const tooltip = disabled
          ? html`<div style="max-width: 260px; line-height: 1.4;">
              <div
                style="display:flex;align-items:center;gap:6px;font-weight:600;color:var(--affine-warning-color);margin-bottom:4px;"
              >
                <span
                  style="display:inline-flex;width:14px;height:14px;color:var(--affine-warning-color);"
                  >${WarningIcon()}</span
                >
                Can't merge yet
              </div>
              <div>
                ${contentCells.length} cells in this range already contain
                content.
              </div>
              <div style="opacity:0.75;margin-top:4px;font-size:11px;">
                Move or delete the highlighted cells, then try again.
              </div>
            </div>`
          : contentCells.length === 1
            ? html`<div style="max-width:240px;line-height:1.4;">
                <div style="font-weight:600;margin-bottom:2px;">Merge cells</div>
                <div style="opacity:0.85;">
                  Content from the marked cell will move into the top-left cell.
                </div>
              </div>`
            : 'Merge selected cells';

        const onMouseEnter = () => {
          if (!disabled) return;
          active.blockedMergeCells = new Set(
            contentCells.map(b => `${b.row},${b.col}`)
          );
        };
        const onMouseLeave = () => {
          if (active.blockedMergeCells.size > 0) {
            active.blockedMergeCells = new Set();
          }
        };
        const onClick = () => {
          if (disabled) return;
          if (!ctx.gfx.getElementById(active.id)) return; // dead model guard
          // Re-evaluate state inside the handler. The toolbar render's
          // `contentCells` closure may be stale (peer Yjs edit, undo) by
          // the time the user clicks — using it would orphan children Y.Map
          // entries pointing to no-longer-existing childIds.
          const fresh = decideMergeState(active);
          if (fresh.disabled) return;
          const b = active.getSelectionBounds();
          if (!b) return;
          const rowSpan = b.maxR - b.minR + 1;
          const colSpan = b.maxC - b.minC + 1;
          ctx.store.captureSync();
          ctx.store.transact(() => {
            // If the single content cell is NOT the origin, relocate the
            // child to the origin so the merged region surfaces it. (≤1
            // content cells per decideMergeState — no overwrite hazard.)
            for (const { childId, row, col } of fresh.contentCells) {
              if (row === b.minR && col === b.minC) continue;
              // Defensive: skip if childId has been removed since the
              // freshly-computed contentCells was built (shouldn't happen
              // in a sync handler, but cheap guard against future async).
              if (!active.children.has(childId)) continue;
              active.children.set(childId, { row: b.minR, col: b.minC });
            }
            active.mergeCells(b.minR, b.minC, rowSpan, colSpan);
          });
          active.selectCell(b.minR, b.minC);
          active.bumpStyleVersion();
          // Force toolbar refresh. Nested-Y.Map @local changes (selectedCells,
          // styleVersion) fire `surface.elementUpdated` but for some reason
          // that path doesn't reach the toolbar widget's renderToolbar
          // effect. Re-asserting framework selection (idempotent) fires
          // `gfx.selection.slots.updated`, which the toolbar's OTHER
          // subscription path does respond to → renderToolbar runs →
          // `when` predicates re-evaluate → button visibility updates.
          ctx.gfx.selection.set({ elements: [active.id], editing: false });
        };
        // NOTE: do NOT set `.disabled` here. editor-icon-button's disabled
        // CSS uses `pointer-events: none`, which kills hover → tooltip never
        // shows, our @mouseenter never fires (no red blocker overlay), user
        // has no clue WHY merge is unavailable. We render the "blocked" state
        // ourselves: warning icon + amber label + dashed-style cursor.
        // Click is gated in onClick. Tooltip + mouseenter stay alive.
        const labelContent = disabled
          ? html`<span
              class="label"
              style="display:inline-flex;align-items:center;gap:4px;color:var(--affine-warning-color);font-weight:500;"
            >
              <span
                style="display:inline-flex;width:14px;height:14px;color:var(--affine-warning-color);flex-shrink:0;"
                >${WarningIcon()}</span
              >
              Merge
            </span>`
          : html`<span class="label">Merge</span>`;

        return html`
          <editor-icon-button
            aria-label="Merge cells"
            .tooltip=${tooltip}
            @click=${onClick}
            @mouseenter=${onMouseEnter}
            @mouseleave=${onMouseLeave}
            style=${disabled ? 'cursor: not-allowed;' : ''}
          >
            ${labelContent}
          </editor-icon-button>
        `;
      },
    },
    {
      id: 'b.unmerge-cells',
      when(ctx) {
        const models = ctx.getSurfaceModelsByType(GridElementModel);
        return models.some(unmergeButtonVisible);
      },
      content(ctx) {
        const models = ctx.getSurfaceModelsByType(GridElementModel);
        const active = models.find(unmergeButtonVisible);
        if (!active) return null;
        const origins = active.getMergeOriginsInSelection();
        // unmergeButtonVisible guarantees exactly one origin.
        const tooltip = 'Split this merged cell back into individual cells';
        const onClick = () => {
          if (!ctx.gfx.getElementById(active.id)) return; // dead model guard
          // Capture span BEFORE unmerging so we can re-select the cells
          // that were just split apart. Without this, the toolbar collapses
          // to "no buttons" after unmerge (single cell selected = neither
          // merge nor unmerge applies under the unified rule), which feels
          // like the action did nothing visible at the toolbar level.
          const reselect = new Set<string>();
          for (const o of origins) {
            const span = active.getCellSpan(o.row, o.col);
            if (!span) continue;
            for (let dr = 0; dr < span.rowSpan; dr++) {
              for (let dc = 0; dc < span.colSpan; dc++) {
                reselect.add(`${o.row + dr},${o.col + dc}`);
              }
            }
          }
          ctx.store.captureSync();
          ctx.store.transact(() => {
            for (const o of origins) active.unmergeCells(o.row, o.col);
          });
          if (reselect.size > 0) {
            active.selectedCells = reselect;
          }
          active.bumpStyleVersion();
          // Force toolbar refresh — see merge onClick for rationale.
          ctx.gfx.selection.set({ elements: [active.id], editing: false });
        };
        return html`
          <editor-icon-button
            aria-label="Unmerge cells"
            .tooltip=${tooltip}
            @click=${onClick}
          >
            <span class="label">Unmerge</span>
          </editor-icon-button>
        `;
      },
    },
  ],

  when: ctx => ctx.getSurfaceModelsByType(GridElementModel).length > 0,
} as const satisfies ToolbarModuleConfig;

export const gridToolbarExtension = ToolbarModuleExtension({
  id: BlockFlavourIdentifier('affine:surface:grid'),
  config: gridToolbarConfig,
});
