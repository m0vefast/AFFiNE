import { EmbedMdBlockSchema } from '@blocksuite/affine-model';
import { BlockViewExtension, FlavourExtension } from '@blocksuite/std';
import type { ExtensionType } from '@blocksuite/store';
import { literal } from 'lit/static-html.js';

const flavour = EmbedMdBlockSchema.model.flavour;

export const EmbedMdBlockSpec: ExtensionType[] = [
  FlavourExtension(flavour),
  BlockViewExtension(flavour, model => {
    const parent = model.store.getParent(model.id);
    if (parent?.flavour === 'affine:surface') {
      return literal`affine-edgeless-embed-md`;
    }
    return literal`affine-embed-md`;
  }),
];
