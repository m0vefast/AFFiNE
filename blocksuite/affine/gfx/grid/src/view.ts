import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from '@blocksuite/affine-ext-loader';

import { GridElementRendererExtension } from './element-renderer';
import { GridDragExtension } from './interactivity';
import { GridInteraction, GridView } from './view/view';

export class GridViewExtension extends ViewExtensionProvider {
  override name = 'affine-grid-gfx';

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(GridElementRendererExtension);
    context.register(GridView);
    context.register(GridInteraction);
    context.register(GridDragExtension);
  }
}
