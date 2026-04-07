import { BlockComponent } from '@blocksuite/std';

/**
 * Page-mode placeholder for embed-md (not used in edgeless-only canvas).
 */
export class EmbedMdBlockComponent extends BlockComponent {
  override renderBlock() {
    return null;
  }
}
