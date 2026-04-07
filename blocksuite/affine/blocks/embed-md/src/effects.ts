import {
  EmbedMdEdgelessBlockComponent,
  EMBED_MD_EDGELESS_BLOCK,
} from './embed-md-block.js';
import { EmbedMdBlockComponent } from './embed-md-page-block.js';

export function effects() {
  customElements.define('affine-embed-md', EmbedMdBlockComponent);
  customElements.define(EMBED_MD_EDGELESS_BLOCK, EmbedMdEdgelessBlockComponent);
}
