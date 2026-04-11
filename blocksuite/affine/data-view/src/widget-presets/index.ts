import { widgetQuickSettingBar } from './quick-setting-bar/index.js';
import { createWidgetTools, toolsWidgetPresets } from './tools/index.js';
import { widgetViewsBar } from './views-bar/index.js';

export const widgetPresets = {
  viewBar: widgetViewsBar,
  quickSettingBar: widgetQuickSettingBar,
  createTools: createWidgetTools,
  tools: toolsWidgetPresets,
};

// Glyph extension: re-export popViewOptions so consumers can call it directly with extraSettingItems
export {
  popViewOptions,
  type ExtraSettingItemsContext,
} from './tools/presets/view-options/view-options.js';
