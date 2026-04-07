import { BlockSchemaExtension, defineBlockSchema } from '@blocksuite/store';

import type { EmbedMdBlockProps } from './md-model.js';
import { EmbedMdModel } from './md-model.js';

const defaultEmbedMdProps: EmbedMdBlockProps = {
  // md-embed specific
  filePath: '',
  embed: false,
  style: 'horizontalThin',
  caption: undefined,
  // GfxCompatible (same as attachment)
  index: 'a0',
  xywh: '[0,0,0,0]',
  lockedBySelf: false,
  rotate: 0,
  // BlockMeta
  'meta:createdAt': undefined,
  'meta:updatedAt': undefined,
  'meta:createdBy': undefined,
  'meta:updatedBy': undefined,
  comments: undefined,
};

export const EmbedMdBlockSchema = defineBlockSchema({
  flavour: 'affine:embed-md',
  props: (): EmbedMdBlockProps => defaultEmbedMdProps,
  metadata: {
    version: 1,
    role: 'content',
    parent: [
      'affine:surface',
      'affine:edgeless-text',
    ],
  },
  toModel: () => new EmbedMdModel(),
});

export const EmbedMdBlockSchemaExtension = BlockSchemaExtension(
  EmbedMdBlockSchema
);
