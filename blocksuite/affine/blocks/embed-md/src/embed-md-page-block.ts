import {
  CaptionedBlockComponent,
  SelectedStyle,
} from '@blocksuite/affine-components/caption';
import { Slice } from '@blocksuite/store';
import { Bound } from '@blocksuite/global/gfx';
import { BlockSelection } from '@blocksuite/std';
import { computed, signal } from '@preact/signals-core';
import { css, html } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { Marked } from 'marked';

import {
  CARD_VIEW_WIDTH, CARD_VIEW_HEIGHT,
  EMBED_VIEW_WIDTH, EMBED_VIEW_HEIGHT,
} from './toolbar.js';

const marked = new Marked();

const EMBED_CSS = `
  html { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.6; color: #1f2328;
    padding: 16px 20px; margin: 0; word-wrap: break-word;
    height: 100%; overflow-y: auto; box-sizing: border-box;
  }
  h1 { font-size: 1.6em; font-weight: 600; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid #d1d9e0; }
  h2 { font-size: 1.35em; font-weight: 600; margin: 16px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d1d9e0; }
  h3 { font-size: 1.15em; font-weight: 600; margin: 12px 0 6px; }
  p { margin: 0 0 10px; }
  code { background: #f0f2f5; padding: 2px 5px; border-radius: 4px; font-size: 0.9em; font-family: 'SF Mono', Monaco, Menlo, monospace; }
  pre { background: #f6f8fa; border-radius: 6px; padding: 12px 16px; overflow-x: auto; margin: 0 0 12px; }
  pre code { background: none; padding: 0; font-size: 0.85em; }
  blockquote { margin: 0 0 12px; padding: 4px 16px; border-left: 3px solid #d1d9e0; color: #636c76; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 12px; }
  th, td { border: 1px solid #d1d9e0; padding: 6px 12px; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  ul, ol { padding-left: 24px; margin: 0 0 10px; }
  li { margin: 2px 0; }
  hr { border: none; border-top: 1px solid #d1d9e0; margin: 16px 0; }
  img { max-width: 100%; }
  a { color: #0969da; text-decoration: none; }
`;

/**
 * Embed-md block — contains ALL rendering logic.
 * Works in both contexts:
 * - Directly in block flow (inside edgeless-text / grid cells)
 * - Wrapped by toGfxBlockComponent for canvas surface placement
 */
export class EmbedMdBlockComponent extends CaptionedBlockComponent {
  static override styles = css`
    affine-embed-md, affine-edgeless-embed-md {
      display: block;
      width: 100%;
      height: 100%;
    }

    .embed-md-container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      border-radius: 8px;
      box-sizing: border-box;
      user-select: none;
      border: 1px solid var(--affine-border-color, #e3e2e4);
      background: var(--affine-background-primary-color, #fff);
      overflow: hidden;
    }

    .embed-md-container.focused {
      border-color: var(--affine-primary-color, #1e81f0);
    }

    /* ---- Card view (compact, like PDF attachment card) ---- */
    .embed-md-card {
      display: flex;
      gap: 12px;
      padding: 12px;
      align-items: center;
      height: 100%;
      box-sizing: border-box;
    }
    .embed-md-card-icon {
      display: flex; align-items: center; justify-content: center;
      font-size: 32px; flex-shrink: 0;
      width: 48px; height: 48px;
    }
    .embed-md-card-info {
      display: flex; flex-direction: column; gap: 4px;
      flex: 1; min-width: 0;
    }
    .embed-md-card-title {
      font-size: 14px; font-weight: 600; line-height: 22px;
      color: var(--affine-text-primary-color, #121212);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .embed-md-card-desc {
      font-size: 12px; line-height: 20px;
      color: var(--affine-text-secondary-color, #8e8d91);
    }
    .embed-md-card-banner {
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; font-size: 40px; opacity: 0.15;
    }

    /* ---- Embed view (header + scrollable iframe) ---- */
    .embed-md-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--affine-border-color, #e3e2e4);
      background: var(--affine-background-secondary-color, #fafafa);
      pointer-events: auto;
      cursor: default;
      min-height: 36px;
    }

    .embed-md-icon { font-size: 14px; flex-shrink: 0; }
    .embed-md-filename {
      font-size: 13px; font-weight: 500;
      color: var(--affine-text-primary-color, #121212);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
    }
    .embed-md-header-btn {
      flex-shrink: 0; border: none; background: transparent; cursor: pointer;
      font-size: 12px; padding: 2px 6px; border-radius: 4px;
      color: var(--affine-text-secondary-color, #8e8d91);
    }
    .embed-md-header-btn:hover {
      background: var(--affine-hover-color, #f1f0f5);
      color: var(--affine-text-primary-color, #121212);
    }

    .embed-md-iframe-wrap { flex-grow: 1; position: relative; width: 100%; height: 100%; }
    .embed-md-iframe-wrap iframe { width: 100%; height: 100%; border: none; }
    .embed-md-event-mask { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
    .embed-md-event-mask.hide { display: none; }

    .embed-md-loading {
      display: flex; align-items: center; justify-content: center;
      height: 100%; color: var(--affine-text-secondary-color, #8e8d91); font-size: 13px; padding: 24px;
    }
    .embed-md-error {
      display: flex; align-items: center; justify-content: center;
      height: 100%; color: var(--affine-error-color, #eb4335); font-size: 13px; padding: 24px;
    }
  `;

  override accessor useCaptionEditor = true;
  override accessor selectedStyle = SelectedStyle.Border;

  blockDraggable = true;

  protected containerStyleMap = styleMap({
    position: 'relative',
    width: '100%',
    height: '100%',
  });

  // Overlay signals — same pattern as YouTube/embed blocks
  readonly isDraggingOnHost$ = signal(false);
  readonly isResizing$ = signal(false);
  readonly showOverlay$ = computed(
    () => this.isDraggingOnHost$.value || this.isResizing$.value || !this.selected$.value
  );

  protected _loading = true;
  protected _error: string | null = null;
  protected _embedBlobUrl = '';

  get filePath(): string {
    return (this.model as any).props?.filePath ?? '';
  }

  get isEmbed(): boolean {
    return (this.model as any).props?.embed === true;
  }

  get fileName(): string {
    return this.filePath.split('/').pop() ?? this.filePath;
  }

  protected _handleOpenSplit(e: Event) {
    e.stopPropagation();
    try { (window as any).glyph?.send?.('flowOpenInSplit', { file: this.filePath }); } catch {}
  }

  protected _toggleView(e: Event) {
    e.stopPropagation();
    const newEmbed = !this.isEmbed;
    const bound = Bound.deserialize(this.model.xywh);
    if (newEmbed) {
      bound.w = EMBED_VIEW_WIDTH; bound.h = EMBED_VIEW_HEIGHT;
    } else {
      bound.w = CARD_VIEW_WIDTH; bound.h = CARD_VIEW_HEIGHT;
    }
    this.store.updateBlock(this.model, { embed: newEmbed, xywh: bound.serialize() } as any);
  }

  private _selectBlock() {
    const selectionManager = this.host.selection;
    const blockSelection = selectionManager.create(BlockSelection, {
      blockId: this.blockId,
    });
    selectionManager.setGroup('note', [blockSelection]);
  }

  protected onClick(event: MouseEvent) {
    if (event.defaultPrevented) return;
    event.stopPropagation();
    if (!this.selected$.peek()) {
      this._selectBlock();
    }
  }

  copy = () => {
    const slice = Slice.fromModels(this.store, [this.model]);
    this.std.clipboard.copySlice(slice).catch(console.error);
  };

  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = 'false';
    if (this.filePath) {
      try { (window as any).glyph?.send?.('flowReadFile', { path: this.filePath }); } catch {}
    }
    const handler = (payload: any) => {
      if (payload?.path !== this.filePath) return;
      if (payload?.error) {
        this._error = payload.error;
        this._loading = false;
        this.requestUpdate();
        return;
      }
      this._processContent(payload?.content ?? '');
    };
    (window as any).__embedMdHandlers = (window as any).__embedMdHandlers ?? new Map();
    (window as any).__embedMdHandlers.set(this.model.id, handler);
  }

  override firstUpdated() {
    this.disposables.addFromEvent(this, 'click', this.onClick.bind(this));
    this.disposables.addFromEvent(this, 'dblclick', (e: MouseEvent) => {
      e.stopPropagation();
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    (window as any).__embedMdHandlers?.delete?.(this.model.id);
    if (this._embedBlobUrl) { URL.revokeObjectURL(this._embedBlobUrl); this._embedBlobUrl = ''; }
  }

  private _processContent(content: string) {
    this._loading = false;
    this._error = null;

    const fullHtml = marked.parse(content) as string;
    const embedHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${EMBED_CSS}</style></head><body>${fullHtml}</body></html>`;
    // Convert to blob URL — same rendering path as PDF embed
    if (this._embedBlobUrl) URL.revokeObjectURL(this._embedBlobUrl);
    this._embedBlobUrl = URL.createObjectURL(new Blob([embedHtml], { type: 'text/html' }));
    this.requestUpdate();
  }

  protected renderCardView() {
    const desc = this._loading ? 'Loading...' : this._error ? this._error : 'Markdown';
    return html`
      <div class="embed-md-card">
        <div class="embed-md-card-icon">📄</div>
        <div class="embed-md-card-info">
          <div class="embed-md-card-title" title=${this.filePath}>${this.fileName}</div>
          <div class="embed-md-card-desc">${desc}</div>
        </div>
        <div class="embed-md-card-banner">📝</div>
      </div>
    `;
  }

  protected renderEmbedView() {
    if (this._loading) return html`<div class="embed-md-iframe-wrap"><div class="embed-md-loading">Loading...</div></div>`;
    if (this._error) return html`<div class="embed-md-iframe-wrap"><div class="embed-md-error">${this._error}</div></div>`;
    // Same rendering path as PDF embed (iframe + blob URL)
    return html`
      <div class="embed-md-iframe-wrap">
        <iframe
          style=${styleMap({
            width: '100%',
            minHeight: '480px',
            colorScheme: 'auto',
          })}
          src=${this._embedBlobUrl}
          loading="lazy"
          frameborder="no"
          allowTransparency
          allowfullscreen
          credentialless
          sandbox="allow-same-origin"
        ></iframe>
        <div
          class=${classMap({
            'embed-md-event-mask': true,
            hide: !this.showOverlay$.value,
          })}
        ></div>
      </div>
    `;
  }

  override renderBlock() {
    const embed = this.isEmbed;
    return html`
      <div
        class=${classMap({
          'embed-md-container': true,
          focused: this.selected$.value,
        })}
        style=${this.containerStyleMap}
      >
        ${embed ? html`
          <div class="embed-md-header">
            <span class="embed-md-icon">📄</span>
            <span class="embed-md-filename" title=${this.filePath}>${this.fileName}</span>
            <button class="embed-md-header-btn" @click=${(e: Event) => this._toggleView(e)} title="Card view">▭</button>
            <button class="embed-md-header-btn" @click=${(e: Event) => this._handleOpenSplit(e)} title="Open in Split View">↗</button>
          </div>
          ${this.renderEmbedView()}
        ` : this.renderCardView()}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-embed-md': EmbedMdBlockComponent;
  }
}
