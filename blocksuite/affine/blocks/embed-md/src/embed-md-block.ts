import { toGfxBlockComponent } from '@blocksuite/std';
import { css, html, nothing } from 'lit';

import { EmbedMdBlockComponent } from './embed-md-page-block.js';

/**
 * Edgeless (canvas) version of the embed-md block.
 * Renders a read-only markdown file preview card on the canvas.
 */
export class EmbedMdEdgelessBlockComponent extends toGfxBlockComponent(
  EmbedMdBlockComponent
) {
  static override styles = css`
    affine-edgeless-embed-md {
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
      border: 1px solid var(--affine-border-color, #e3e2e4);
      background: var(--affine-background-primary-color, #fff);
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    }

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
      font-size: 13px;
      font-weight: 500;
      color: var(--affine-text-primary-color, #121212);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .embed-md-open-btn {
      flex-shrink: 0;
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 14px;
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--affine-text-secondary-color, #8e8d91);
    }

    .embed-md-open-btn:hover {
      background: var(--affine-hover-color, #f1f0f5);
      color: var(--affine-text-primary-color, #121212);
    }

    .embed-md-content {
      flex: 1;
      overflow: hidden;
      pointer-events: none;
      position: relative;
      padding: 12px 16px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--affine-text-primary-color, #121212);
    }

    .embed-md-content::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 40px;
      background: linear-gradient(transparent, var(--affine-background-primary-color, #fff));
      pointer-events: none;
    }

    .embed-md-content h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
    .embed-md-content h2 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
    .embed-md-content h3 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
    .embed-md-content p { margin: 0 0 8px; }
    .embed-md-content code { background: var(--affine-hover-color, #f1f0f5); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    .embed-md-content li { margin-left: 16px; }

    .embed-md-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--affine-text-secondary-color, #8e8d91);
      font-size: 13px;
      padding: 24px;
    }

    .embed-md-error {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--affine-error-color, #eb4335);
      font-size: 13px;
      padding: 24px;
    }

    .embed-md-truncated {
      text-align: center;
      padding: 8px;
      font-size: 12px;
      color: var(--affine-text-secondary-color, #8e8d91);
      border-top: 1px solid var(--affine-border-color, #e3e2e4);
    }
  `;

  // State managed via plain properties + requestUpdate()
  private _loading = true;
  private _error: string | null = null;
  private _truncated = false;
  private _contentHtml = '';

  get filePath(): string {
    return (this.model as any).props?.filePath ?? '';
  }

  get fileName(): string {
    const path = this.filePath;
    return path.split('/').pop() ?? path;
  }

  private _handleOpenSplit(e: Event) {
    e.stopPropagation();
    try {
      (window as any).glyph?.send?.('flowOpenInSplit', { file: this.filePath });
    } catch {}
  }

  private _handleDblClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      (window as any).glyph?.send?.('flowOpenInSplit', { file: this.filePath });
    } catch {}
  }

  override connectedCallback() {
    super.connectedCallback();

    if (this.filePath) {
      try {
        (window as any).glyph?.send?.('flowReadFile', { path: this.filePath });
      } catch {}
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

  override disconnectedCallback() {
    super.disconnectedCallback();
    (window as any).__embedMdHandlers?.delete?.(this.model.id);
  }

  private _processContent(content: string) {
    const MAX_LINES = 200;
    const MAX_BYTES = 100_000;
    const lines = content.split('\n');

    let markdown = content;
    let truncated = false;

    if (lines.length > MAX_LINES) {
      markdown = lines.slice(0, MAX_LINES).join('\n');
      truncated = true;
    } else if (content.length > MAX_BYTES) {
      markdown = content.slice(0, MAX_BYTES);
      truncated = true;
    }

    this._truncated = truncated;
    this._loading = false;
    this._error = null;
    this._contentHtml = this._renderMarkdown(markdown);
    this.requestUpdate();
  }

  private _renderMarkdown(md: string): string {
    return md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  override renderGfxBlock() {
    const content = this._loading
      ? html`<div class="embed-md-loading">Loading...</div>`
      : this._error
        ? html`<div class="embed-md-error">${this._error}</div>`
        : html`<div .innerHTML=${this._contentHtml}></div>`;

    return html`
      <div class="embed-md-container" @dblclick=${this._handleDblClick}>
        <div class="embed-md-header">
          <span class="embed-md-icon">📄</span>
          <span class="embed-md-filename" title=${this.filePath}>${this.fileName}</span>
          <button class="embed-md-open-btn" @click=${(e: Event) => this._handleOpenSplit(e)} title="Open in Split View">↗</button>
        </div>
        <div class="embed-md-content">
          ${content}
        </div>
        ${this._truncated ? html`<div class="embed-md-truncated">Open file to see full content</div>` : nothing}
      </div>
    `;
  }
}

export const EMBED_MD_BLOCK = 'affine-embed-md';
export const EMBED_MD_EDGELESS_BLOCK = 'affine-edgeless-embed-md';
