import { EdgelessLegacySlotIdentifier } from '@blocksuite/affine-block-surface';
import { EmbedMdBlockSchema } from '@blocksuite/affine-model';
import { Bound } from '@blocksuite/global/gfx';
import { toGfxBlockComponent } from '@blocksuite/std';
import { GfxViewInteractionExtension } from '@blocksuite/std/gfx';

import { EmbedMdBlockComponent } from './embed-md-page-block.js';

/**
 * Edgeless (canvas) version — follows YouTube embed pattern (toEdgelessEmbedBlock):
 * sets blockContainerStyles to actual xywh size, content fills naturally.
 * NOT the attachment pattern (CSS scaling) which distorts content.
 */
export class EmbedMdEdgelessBlockComponent extends toGfxBlockComponent(
  EmbedMdBlockComponent
) {
  override selectedStyle$ = null;

  override blockDraggable = false;

  get edgelessSlots() {
    return this.std.get(EdgelessLegacySlotIdentifier);
  }

  override onClick(_: MouseEvent) {
    return;
  }

  override connectedCallback() {
    super.connectedCallback();
    this._disposables.add(
      this.edgelessSlots.elementResizeStart.subscribe(() => {
        this.isResizing$.value = true;
      })
    );
    this._disposables.add(
      this.edgelessSlots.elementResizeEnd.subscribe(() => {
        this.isResizing$.value = false;
      })
    );
  }

  override renderGfxBlock() {
    const bound = Bound.deserialize(this.model.xywh);

    this.blockContainerStyles = {
      width: `${bound.w}px`,
      height: `${bound.h}px`,
    };

    return this.renderPageContent();
  }

  protected override accessor blockContainerStyles: Record<string, string> | undefined = undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-edgeless-embed-md': EmbedMdEdgelessBlockComponent;
  }
}

export const EmbedMdBlockInteraction = GfxViewInteractionExtension(
  EmbedMdBlockSchema.model.flavour,
  {
    resizeConstraint: { lockRatio: false },
    handleRotate: () => ({
      beforeRotate: context => { context.set({ rotatable: false }); },
    }),
  }
);

export const EMBED_MD_BLOCK = 'affine-embed-md';
export const EMBED_MD_EDGELESS_BLOCK = 'affine-edgeless-embed-md';
