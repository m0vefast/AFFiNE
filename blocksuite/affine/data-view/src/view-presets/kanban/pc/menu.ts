import {
  menu,
  popFilterableSimpleMenu,
  type PopupTarget,
} from '@blocksuite/affine-components/context-menu';
import {
  ArrowRightBigIcon,
  DeleteIcon,
  ExpandFullIcon,
  MoveLeftIcon,
  MoveRightIcon,
} from '@blocksuite/icons/lit';
import { html } from 'lit';

import type { KanbanSelectionController } from './controller/selection.js';
import type { KanbanViewUILogic } from './kanban-view-ui-logic.js';

export const openDetail = (
  kanbanViewLogic: KanbanViewUILogic,
  rowId: string,
  selection: KanbanSelectionController
) => {
  const old = selection.selection;
  selection.selection = undefined;
  kanbanViewLogic.root.openDetailPanel({
    view: selection.view,
    rowId: rowId,
    onClose: () => {
      selection.selection = old;
    },
  });
};

export const popCardMenu = (
  kanbanViewLogic: KanbanViewUILogic,
  ele: PopupTarget,
  rowId: string,
  selection: KanbanSelectionController
) => {
  const groups = (selection.view.groupTrait.groupsDataList$.value ?? []).filter(
    (v): v is NonNullable<typeof v> => v != null
  );
  popFilterableSimpleMenu(ele, [
    menu.action({
      name: 'Expand Card',
      prefix: ExpandFullIcon(),
      select: () => {
        openDetail(kanbanViewLogic, rowId, selection);
      },
    }),
    menu.subMenu({
      name: 'Move To',
      prefix: ArrowRightBigIcon(),
      options: {
        items:
          groups
            .filter(v => {
              const cardSelection = selection.selection;
              if (cardSelection?.selectionType === 'card') {
                const currentGroup = cardSelection.cards[0]?.groupKey;
                return currentGroup ? v.key !== currentGroup : true;
              }
              return false;
            })
            .map(group =>
              menu.action({
                name: group.value != null ? group.name$.value : 'Ungroup',
                select: () => {
                  selection.moveCard(rowId, group.key);
                },
              })
            ) ?? [],
      },
    }),
    // GLYPH PATCH: removed Insert/Delete card actions — cards managed by source files
  ]);
};
