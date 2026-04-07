import { EmbedMdBlockSchema, EmbedMdModel } from '@blocksuite/affine-model';
import {
  ActionPlacement,
  type ToolbarAction,
  type ToolbarActionGroup,
  type ToolbarModuleConfig,
  ToolbarModuleExtension,
} from '@blocksuite/affine-shared/services';
import { getBlockProps } from '@blocksuite/affine-shared/utils';
import { Bound } from '@blocksuite/global/gfx';
import { BlockFlavourIdentifier } from '@blocksuite/std';
import { computed } from '@preact/signals-core';
import { html } from 'lit';
import type { ExtensionType } from '@blocksuite/store';
import {
  CaptionIcon,
  CopyIcon,
  DeleteIcon,
  DuplicateIcon,
  OpenInNewIcon,
  ResetIcon,
} from '@blocksuite/icons/lit';

import { EmbedMdEdgelessBlockComponent } from './embed-md-block.js';

// Card view dimensions (compact metadata card)
export const CARD_VIEW_WIDTH = 300;
export const CARD_VIEW_HEIGHT = 80;

// Embed view dimensions (scrollable markdown preview — matches PDF)
export const EMBED_VIEW_WIDTH = 563;
export const EMBED_VIEW_HEIGHT = 831;

// ── Helpers ────────────────────────────────────────────────────

function getBlock(ctx: any): EmbedMdEdgelessBlockComponent | null {
  return ctx.getCurrentBlockByType(EmbedMdEdgelessBlockComponent) ?? null;
}

function getFilePath(block: EmbedMdEdgelessBlockComponent): string {
  return (block.model as any).props?.filePath ?? '';
}

// ── View toggle (card ↔ embed) ─────────────────────────────────

const viewDropdownMenu = {
  id: 'b.conversions',
  actions: [
    {
      id: 'card',
      label: 'Card view',
      run(ctx: any) {
        const block = getBlock(ctx);
        if (!block) return;
        const model = block.model;
        const bounds = Bound.deserialize(model.xywh);
        bounds.w = CARD_VIEW_WIDTH;
        bounds.h = CARD_VIEW_HEIGHT;
        ctx.store.updateBlock(model, { embed: false, xywh: bounds.serialize() });
      },
    },
    {
      id: 'embed',
      label: 'Embed view',
      run(ctx: any) {
        const block = getBlock(ctx);
        if (!block) return;
        const model = block.model;
        const bounds = Bound.deserialize(model.xywh);
        bounds.w = EMBED_VIEW_WIDTH;
        bounds.h = EMBED_VIEW_HEIGHT;
        ctx.store.updateBlock(model, { embed: true, xywh: bounds.serialize() });
      },
    },
  ],
  content(ctx: any) {
    const block = getBlock(ctx);
    if (!block) return null;
    const model = block.model;

    const actions = computed(() => {
      const [cardAction, embedAction] = this.actions.map((a: any) => ({ ...a }));
      const embed = (model as any).props?.embed$?.value ?? false;
      cardAction.disabled = !embed;
      embedAction.disabled = embed;
      return [cardAction, embedAction];
    });
    const viewType$ = computed(() => {
      const embed = (model as any).props?.embed$?.value ?? false;
      return embed ? 'Embed view' : 'Card view';
    });

    return html`<affine-view-dropdown-menu
      .actions=${actions.value}
      .context=${ctx}
      .viewTypeSignal=${viewType$}
    ></affine-view-dropdown-menu>`;
  },
} as const satisfies ToolbarActionGroup<ToolbarAction>;

// ── Open in Split View ──────────────────────────────────────────

const openSplitAction = {
  id: 'c.open-split',
  tooltip: 'Open in Split View',
  icon: OpenInNewIcon(),
  run(ctx: any) {
    const block = getBlock(ctx);
    if (!block) return;
    const path = getFilePath(block);
    if (path) {
      try {
        (window as any).glyph?.send?.('flowOpenInSplit', { file: path });
      } catch {}
    }
  },
} as const satisfies ToolbarAction;

// ── Caption ────────────────────────────────────────────────────

const captionAction = {
  id: 'e.caption',
  tooltip: 'Caption',
  icon: CaptionIcon(),
  run(ctx: any) {
    const block = getBlock(ctx);
    (block as any)?.captionEditor?.show();
  },
} as const satisfies ToolbarAction;

// ── More menu ──────────────────────────────────────────────────

const builtinSurfaceToolbarConfig = {
  actions: [
    viewDropdownMenu,
    openSplitAction,
    captionAction,
    {
      placement: ActionPlacement.More,
      id: 'a.clipboard',
      actions: [
        {
          id: 'copy',
          label: 'Copy',
          icon: CopyIcon(),
          run(ctx: any) {
            const block = getBlock(ctx);
            (block as any)?.copy?.();
          },
        },
        {
          id: 'duplicate',
          label: 'Duplicate',
          icon: DuplicateIcon(),
          run(ctx: any) {
            const block = getBlock(ctx);
            if (!block) return;
            const model = block.model;
            ctx.store.addSiblingBlocks(model, [{
              flavour: model.flavour,
              ...getBlockProps(model),
            }]);
          },
        },
      ],
    },
    {
      placement: ActionPlacement.More,
      id: 'b.reload',
      label: 'Reload',
      icon: ResetIcon(),
      run(ctx: any) {
        const block = getBlock(ctx);
        if (!block) return;
        const path = getFilePath(block);
        if (path) {
          try {
            (window as any).glyph?.send?.('flowReadFile', { path });
          } catch {}
        }
      },
    },
    {
      placement: ActionPlacement.More,
      id: 'c.delete',
      label: 'Delete',
      icon: DeleteIcon(),
      variant: 'destructive',
      run(ctx: any) {
        const model = ctx.getCurrentModel();
        if (!model) return;
        ctx.store.deleteBlock(model.id);
        ctx.select('note');
        ctx.reset();
      },
    },
  ],
  when: (ctx: any) => ctx.getSurfaceModelsByType(EmbedMdModel as any).length === 1,
} as const satisfies ToolbarModuleConfig;

// ── Extension registration ─────────────────────────────────────

const flavour = EmbedMdBlockSchema.model.flavour;
const name = flavour.split(':').pop();

export const embedMdToolbarExtensions: ExtensionType[] = [
  ToolbarModuleExtension({
    id: BlockFlavourIdentifier(`affine:surface:${name}`),
    config: builtinSurfaceToolbarConfig,
  }),
];
