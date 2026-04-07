import { BlockModel } from '@blocksuite/store';

import { defineEmbedModel } from '../../../utils/index.js';
import type { EmbedCardStyle } from '../../../utils/types.js';
import type { GfxCommonBlockProps } from '@blocksuite/std/gfx';
import type { BlockMeta } from '../../../utils/types.js';

export type EmbedMdBlockProps = {
  filePath: string;
  /** true = scrollable embed preview, false/undefined = compact card */
  embed: boolean;
  /** Card layout style — matches attachment block pattern */
  style: EmbedCardStyle;
  /** Optional caption text */
  caption?: string;
  comments?: Record<string, boolean>;
} & Omit<GfxCommonBlockProps, 'scale'> &
  BlockMeta;

export class EmbedMdModel extends defineEmbedModel<EmbedMdBlockProps>(
  BlockModel
) {}
