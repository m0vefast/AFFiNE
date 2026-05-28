import { widgetQuickSettingBar } from './quick-setting-bar/index.js';
import { createWidgetTools, toolsWidgetPresets } from './tools/index.js';
import { widgetViewsBar } from './views-bar/index.js';

export const widgetPresets = {
  viewBar: widgetViewsBar,
  quickSettingBar: widgetQuickSettingBar,
  createTools: createWidgetTools,
  tools: toolsWidgetPresets,
};

// Glyph extension: re-export popViewOptions so consumers can call it directly.
// Glyph-specific menu items should be injected via dataViewLogic.getViewOptionsSettingItems
// (upstream hook added in #14984 / canary 2026-05).
export { popViewOptions } from './tools/presets/view-options/view-options.js';
