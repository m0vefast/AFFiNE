import { BlockSchemaExtension } from '@blocksuite/store';

import { createEmbedBlockSchema } from '../../../utils/index.js';
import { type EmbedMdBlockProps, EmbedMdModel } from './md-model.js';

const defaultEmbedMdProps: EmbedMdBlockProps = {
  filePath: '',
};

export const EmbedMdBlockSchema = createEmbedBlockSchema({
  name: 'md',
  version: 1,
  toModel: () => new EmbedMdModel(),
  props: (): EmbedMdBlockProps => defaultEmbedMdProps,
});

export const EmbedMdBlockSchemaExtension = BlockSchemaExtension(
  EmbedMdBlockSchema
);
