import type { OverlayHost } from './host';
import type { Rect } from '../types';

export type OverlayStatusUpdate =
  | { state: 'checking' }
  | { state: 'checked'; issueCount: number }
  | { state: 'partial'; issueCount: number; droppedCount: number; message?: string }
  | { state: 'error'; message: string };

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// A clean result needs no lingering pill over the page. Problems stay visible.
const CHECKED_VISIBLE_MS = 2_500;

/** Announces checker progress beside the active field. */
export class OverlayStatus {
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessage = '';

  constructor(private host: OverlayHost) {}

  announce(update: OverlayStatusUpdate, anchor?: Rect): void {
    const layer = this.host.statusLayer;
    const message = this.message(update);
    // Scrolling and resizing re-render the same result. Once a clean result
    // has faded, repeating it would only flash the pill again.
    if (update.state === 'checked' && message === this.lastMessage && layer.dataset.state === 'checked') {
      if (!layer.hidden) this.position(anchor);
      return;
    }
    this.lastMessage = message;
    this.cancelHide();
    layer.hidden = false;
    layer.dataset.state = update.state;
    layer.setAttribute('role', update.state === 'error' ? 'alert' : 'status');
    layer.textContent = message;
    // Position after the text is in place so the real height is measured.
    this.position(anchor);
    if (update.state === 'checked') {
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        layer.hidden = true;
      }, CHECKED_VISIBLE_MS);
    }
  }

  private message(update: OverlayStatusUpdate): string {
    if (update.state === 'checking') {
      return 'Inkwell is checking this text.';
    }
    if (update.state === 'checked') {
      const count = Math.max(0, Math.trunc(update.issueCount));
      return count === 0
        ? 'Check complete. No suggestions.'
        : `Check complete. ${countLabel(count, 'suggestion', 'suggestions')}.`;
    }
    if (update.state === 'partial') {
      const issueCount = Math.max(0, Math.trunc(update.issueCount));
      const droppedCount = Math.max(0, Math.trunc(update.droppedCount));
      // The provider's own hint (how to start Ollama and so on) is shown in
      // the toolbar popup. In the page, a short line keeps the pill clear of
      // the writing, even inside a small framed editor.
      if (update.message) {
        return `${countLabel(issueCount, 'suggestion', 'suggestions')}. Offline check only, your model is unavailable.`;
      }
      const unplaced = droppedCount > 0
        ? ` ${countLabel(droppedCount, 'suggestion', 'suggestions')} could not be placed.`
        : '';
      return `Check incomplete. ${countLabel(issueCount, 'suggestion', 'suggestions')} available.${unplaced}`;
    }

    return `Check failed. ${update.message}`;
  }

  private cancelHide(): void {
    if (this.hideTimer === null) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  clear(): void {
    this.cancelHide();
    this.lastMessage = '';
    const layer = this.host.statusLayer;
    layer.hidden = true;
    layer.textContent = '';
    delete layer.dataset.state;
    layer.setAttribute('role', 'status');
  }

  private position(anchor?: Rect): void {
    const layer = this.host.statusLayer;
    if (!anchor) {
      layer.style.left = '8px';
      layer.style.top = '8px';
      return;
    }
    // Sit under the field's right-hand corner, where it is least likely to
    // cover the next label or the start of the text. If there is no room
    // below, sit fully above the field rather than over the writing.
    const width = layer.offsetWidth || 280;
    const height = layer.offsetHeight || 36;
    const right = anchor.left + anchor.width;
    const left = Math.min(Math.max(right - width, 8), Math.max(8, window.innerWidth - width - 8));
    const below = anchor.top + anchor.height + 6;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6);
    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
  }
}
