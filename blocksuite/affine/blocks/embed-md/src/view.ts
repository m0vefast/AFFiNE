import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine-ext-loader';

import { effects } from './effects.js';
import { EmbedMdBlockInteraction } from './embed-md-block.js';
import { EmbedMdBlockSpec } from './embed-md-spec.js';
import { embedMdToolbarExtensions } from './toolbar.js';

export class EmbedMdViewExtension extends ViewExtensionProvider {
  override name = 'affine-embed-md-block';

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(EmbedMdBlockSpec);
    context.register(embedMdToolbarExtensions);
    context.register(EmbedMdBlockInteraction);
  }
}
