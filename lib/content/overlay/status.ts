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

/** Announces checker progress without adding visible UI to the host page. */
export class OverlayStatus {
  constructor(private host: OverlayHost) {}

  announce(update: OverlayStatusUpdate, anchor?: Rect): void {
    const layer = this.host.statusLayer;
    layer.hidden = false;
    layer.dataset.state = update.state;
    layer.setAttribute('role', update.state === 'error' ? 'alert' : 'status');
    this.position(anchor);

    if (update.state === 'checking') {
      layer.textContent = 'Inkwell is checking this text.';
      return;
    }
    if (update.state === 'checked') {
      const count = Math.max(0, Math.trunc(update.issueCount));
      layer.textContent =
        count === 0
          ? 'Check complete. No suggestions.'
          : `Check complete. ${countLabel(count, 'suggestion', 'suggestions')}.`;
      return;
    }
    if (update.state === 'partial') {
      const issueCount = Math.max(0, Math.trunc(update.issueCount));
      const droppedCount = Math.max(0, Math.trunc(update.droppedCount));
      const available =
        `Check incomplete. ${countLabel(issueCount, 'suggestion', 'suggestions')} available.`;
      const contextual = update.message
        ? ` The contextual check was unavailable. ${update.message}`
        : '';
      const unplaced = droppedCount > 0
        ? ` ${countLabel(droppedCount, 'suggestion', 'suggestions')} could not be placed.`
        : '';
      layer.textContent = available + contextual + unplaced;
      return;
    }

    layer.textContent = `Check failed. ${update.message}`;
  }

  clear(): void {
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
    const left = Math.min(Math.max(anchor.left, 8), Math.max(8, window.innerWidth - 288));
    const below = anchor.top + anchor.height + 6;
    const top = below < window.innerHeight - 44 ? below : Math.max(8, anchor.top - 36);
    layer.style.left = `${left}px`;
    layer.style.top = `${top}px`;
  }
}
