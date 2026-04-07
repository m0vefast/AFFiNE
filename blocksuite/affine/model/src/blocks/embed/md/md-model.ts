import { BlockModel } from '@blocksuite/store';

import { defineEmbedModel } from '../../../utils/index.js';

export type EmbedMdBlockProps = {
  filePath: string;
};

export class EmbedMdModel extends defineEmbedModel<EmbedMdBlockProps>(
  BlockModel
) {}
