import {
  type CanvasRenderer,
  type ElementRenderer,
  ElementRendererExtension,
  type RoughCanvas,
} from '@blocksuite/affine-block-surface';
import {
  getFontMetrics,
  getFontString,
  getLineWidth,
  isRTL,
  measureTextInDOM,
  wrapTextDeltas,
} from '@blocksuite/affine-gfx-text';
import type {
  LocalShapeElementModel,
  ShapeElementModel,
  ShapeType,
} from '@blocksuite/affine-model';
import { DefaultTheme, TextAlign } from '@blocksuite/affine-model';
import type { IBound } from '@blocksuite/global/gfx';
import { Bound } from '@blocksuite/global/gfx';

// ── Stencil data replay (self-contained shape ops stored in Yjs) ────────────
// stencilData is a JSON string: { w, h, ops: [[cmd, ...args], ...] }
// Replay function provided by the web-canvas layer at runtime.
type StencilReplayFn = (ctx: CanvasRenderingContext2D, json: string, w: number, h: number, fill?: string, stroke?: string) => boolean;
let _replayFn: StencilReplayFn | null = null;
export function setStencilReplayFn(fn: StencilReplayFn) { _replayFn = fn; }
import { deltaInsertsToChunks } from '@blocksuite/std/inline';

import { diamond } from './diamond.js';
import { ellipse } from './ellipse.js';
import { rect } from './rect.js';
import { triangle } from './triangle.js';
import { type Colors, horizontalOffset, verticalOffset } from './utils.js';

const shapeRenderers: Record<
  ShapeType,
  (
    model: ShapeElementModel | LocalShapeElementModel,
    ctx: CanvasRenderingContext2D,
    matrix: DOMMatrix,
    renderer: CanvasRenderer,
    rc: RoughCanvas,
    colors: Colors
  ) => void
> = {
  diamond,
  rect,
  triangle,
  ellipse,
};

export const shape: ElementRenderer<ShapeElementModel> = (
  model,
  ctx,
  matrix,
  renderer,
  rc
) => {
  const color = renderer.getColorValue(
    model.color,
    DefaultTheme.shapeTextColor,
    true
  );
  const fillColor = renderer.getColorValue(
    model.fillColor,
    DefaultTheme.shapeFillColor,
    true
  );
  const strokeColor = renderer.getColorValue(
    model.strokeColor,
    DefaultTheme.shapeStrokeColor,
    true
  );
  const colors = { color, fillColor, strokeColor };

  // Stencil override: if stencilData is set, replay stored Canvas 2D ops
  if (model.stencilData && _replayFn) {
    const { filled, rotate, strokeStyle, strokeWidth } = model;
    const [, , w, h] = model.deserializedXYWH;
    const renderOffset = Math.max(strokeWidth, 0) / 2;
    const renderWidth = w - renderOffset * 2;
    const renderHeight = h - renderOffset * 2;
    const cx = renderWidth / 2;
    const cy = renderHeight / 2;

    ctx.setTransform(
      matrix
        .translateSelf(renderOffset, renderOffset)
        .translateSelf(cx, cy)
        .rotateSelf(rotate)
        .translateSelf(-cx, -cy)
    );

    const effectiveStroke = strokeStyle === 'none' ? 'transparent' : 'rgba(0, 0, 0, 0.55)';
    ctx.fillStyle = filled ? fillColor : 'transparent';
    ctx.strokeStyle = effectiveStroke;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (strokeStyle === 'dash') ctx.setLineDash([12, 12]);
    else ctx.setLineDash([]);

    try {
      _replayFn(ctx, model.stencilData, renderWidth, renderHeight,
        filled ? fillColor : 'transparent', effectiveStroke);
    } finally {
      ctx.setTransform(
        ctx
          .getTransform()
          .translateSelf(cx, cy)
          .rotateSelf(-rotate)
          .translateSelf(-cx, -cy)
          .translateSelf(-renderOffset, -renderOffset)
          .translateSelf(cx, cy)
          .rotateSelf(rotate)
          .translateSelf(-cx, -cy)
      );
    }
  } else {
    shapeRenderers[model.shapeType](model, ctx, matrix, renderer, rc, colors);
  }

  if (model.textDisplay) {
    renderText(model, ctx, colors);
  }
};

export const ShapeElementRendererExtension = ElementRendererExtension(
  'shape',
  shape
);

export * from './utils';

function renderText(
  model: ShapeElementModel | LocalShapeElementModel,
  ctx: CanvasRenderingContext2D,
  { color }: Colors
) {
  const {
    x,
    y,
    text,
    fontSize,
    fontFamily,
    fontWeight,
    textAlign,
    w,
    h,
    textVerticalAlign,
    padding,
  } = model;
  if (!text) return;

  const [verticalPadding, horPadding] = padding;
  const font = getFontString(model);
  const { lineGap, lineHeight } = measureTextInDOM(
    fontFamily,
    fontSize,
    fontWeight
  );
  const metrics = getFontMetrics(fontFamily, fontSize, fontWeight);
  const lines =
    typeof text === 'string'
      ? [text.split('\n').map(line => ({ insert: line }))]
      : deltaInsertsToChunks(wrapTextDeltas(text, font, w - horPadding * 2));
  const horOffset = horizontalOffset(model.w, model.textAlign, horPadding);
  const vertOffset =
    verticalOffset(
      lines,
      lineHeight + lineGap,
      h,
      textVerticalAlign,
      verticalPadding
    ) +
    metrics.fontBoundingBoxAscent +
    lineGap / 2;
  let maxLineWidth = 0;

  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = textAlign;
  ctx.textBaseline = 'alphabetic';

  for (const [lineIndex, line] of lines.entries()) {
    for (const delta of line) {
      const str = delta.insert;
      const rtl = isRTL(str);
      const shouldTemporarilyAttach = rtl && !ctx.canvas.isConnected;
      if (shouldTemporarilyAttach) {
        // to correctly render RTL text mixed with LTR, we have to append it
        // to the DOM
        document.body.append(ctx.canvas);
      }

      if (ctx.canvas.dir !== (rtl ? 'rtl' : 'ltr')) {
        ctx.canvas.setAttribute('dir', rtl ? 'rtl' : 'ltr');
      }

      ctx.fillText(
        str,
        // 0.5 is the dom editor padding to make the text align with the DOM text
        horOffset + 0.5,
        lineIndex * lineHeight + vertOffset
      );

      maxLineWidth = Math.max(maxLineWidth, getLineWidth(str, font));

      if (shouldTemporarilyAttach) {
        ctx.canvas.remove();
      }
    }
  }

  const offsetX =
    model.textAlign === TextAlign.Center
      ? (w - maxLineWidth) / 2
      : model.textAlign === TextAlign.Left
        ? horOffset
        : horOffset - maxLineWidth;
  const offsetY = vertOffset - lineHeight + verticalPadding / 2;

  const bound = new Bound(
    x + offsetX,
    y + offsetY,
    maxLineWidth,
    lineHeight * lines.length
  ) as IBound;

  bound.rotate = model.rotate ?? 0;
  model.textBound = bound;
}
