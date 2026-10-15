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

// Informational results fade on their own. Errors stay until dismissed.
const FADE_AFTER_MS: Partial<Record<OverlayStatusUpdate['state'], number>> = {
  checked: 2_500,
  partial: 6_000,
};

interface QuietState {
  /** The person closed the pill: stop showing progress on this page. */
  quiet: boolean;
  /** An error they closed. A different error still appears. */
  dismissedError: string | null;
}

// Keyed by overlay host, so the choice lasts until the page's overlay is
// torn down (a reload, or Inkwell being switched off for the site).
const quietByHost = new WeakMap<OverlayHost, QuietState>();

function quietState(host: OverlayHost): QuietState {
  let state = quietByHost.get(host);
  if (!state) {
    state = { quiet: false, dismissedError: null };
    quietByHost.set(host, state);
  }
  return state;
}

/** Announces checker progress beside the active field. */
export class OverlayStatus {
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessage = '';

  constructor(private host: OverlayHost) {
    // Keep the caret in the field: closing the pill must not move focus.
    host.statusClose.onmousedown = (event) => event.preventDefault();
    host.statusClose.onclick = () => {
      const state = quietState(host);
      state.quiet = true;
      if (host.statusLayer.dataset.state === 'error') {
        state.dismissedError = host.statusText.textContent;
      }
      this.cancelHide();
      host.statusLayer.hidden = true;
    };
  }

  announce(update: OverlayStatusUpdate, anchor?: Rect): void {
    const layer = this.host.statusLayer;
    const message = this.message(update);
    // Once closed, only a new error comes back. Underlines and the toolbar
    // badge still show every suggestion.
    const quiet = quietState(this.host);
    if (update.state === 'error' ? quiet.dismissedError === message : quiet.quiet) {
      this.cancelHide();
      layer.hidden = true;
      return;
    }
    // Scrolling and resizing re-render the same result. Once it has faded,
    // repeating it would only flash the pill again.
    if (
      (update.state === 'checked' || update.state === 'partial') &&
      message === this.lastMessage &&
      layer.dataset.state === update.state
    ) {
      if (!layer.hidden) this.position(anchor);
      return;
    }
    this.lastMessage = message;
    this.cancelHide();
    layer.hidden = false;
    layer.dataset.state = update.state;
    layer.setAttribute('role', update.state === 'error' ? 'alert' : 'status');
    this.host.statusText.textContent = message;
    // Position after the text is in place so the real height is measured.
    this.position(anchor);
    const fadeAfter = FADE_AFTER_MS[update.state];
    if (fadeAfter !== undefined) {
      this.hideTimer = setTimeout(() => {
        this.hideTimer = null;
        layer.hidden = true;
      }, fadeAfter);
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
    this.host.statusText.textContent = '';
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
