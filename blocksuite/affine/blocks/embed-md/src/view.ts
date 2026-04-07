import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine-ext-loader';

import { effects } from './effects.js';
import { EmbedMdBlockSpec } from './embed-md-spec.js';

export class EmbedMdViewExtension extends ViewExtensionProvider {
  override name = 'affine-embed-md-block';

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(EmbedMdBlockSpec);
  }
}
