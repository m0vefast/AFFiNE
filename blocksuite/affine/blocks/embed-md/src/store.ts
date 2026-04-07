import {
  type StoreExtensionContext,
  StoreExtensionProvider,
} from '@blocksuite/affine-ext-loader';
import { EmbedMdBlockSchemaExtension } from '@blocksuite/affine-model';

export class EmbedMdStoreExtension extends StoreExtensionProvider {
  override name = 'affine-embed-md-block';

  override setup(context: StoreExtensionContext) {
    super.setup(context);
    context.register(EmbedMdBlockSchemaExtension);
  }
}
