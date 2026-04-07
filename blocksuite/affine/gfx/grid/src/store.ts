import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from '@blocksuite/affine-ext-loader';

export class GridStoreExtension extends StoreExtensionProvider {
  override name = 'affine-grid-gfx';

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    // Grid does not need export adapters for now
  }
}
